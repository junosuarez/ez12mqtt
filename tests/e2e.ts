import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { GenericContainer, Network, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { errorMessage, logger } from '../src/logger.ts';

// Note: It is never correct to increase this timeout. A timeout error always indicates a correctness bug.
const ASSERTION_TIMEOUT = 60 * 1000;

const MQTT_BASE_TOPIC = 'ez12mqtt_test';
const DEVICE_NICKNAME = 'mock_inverter';
const MOCK_DEVICE_ID = 'E28000000238';
const OFFLINE_DEVICE_NICKNAME = 'offline_inverter';
const HOMEASSISTANT_DISCOVERY_PREFIX = 'homeassistant';

const logOnPass = process.argv.includes('--log-on-pass');
// `--only=<text>` runs just the scenarios whose name contains <text> (case-insensitive).
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).toLowerCase();

/** The discovery fields the assertions below read back. */
interface DiscoveryMessage {
  name: string;
  state_topic?: string;
  availability_topic?: string;
  command_topic?: string;
  device: { identifiers: string[] };
}

interface TestOptions {
  testName: string;
  prePopulate: boolean;
  expectedDiscoveryMessages: number;
  expectOfflineDevice: boolean;
  // Sun scenarios pin "now" via SUN_NOW_OVERRIDE at Null Island, so day and night are fixed
  // facts rather than whenever the suite happens to run.
  sunNow?: string;
  expectPollSkipped?: boolean;
  // A sleeping inverter never comes online, so the online-path assertions cannot apply.
  onlySunAssertions?: boolean;
  // Device 1 configured without DEVICE_1_NICKNAME: its topic is then the device ID, learned from the
  // inverter. Also asserts nothing is ever published to `<base>//…` (#9).
  nicknameless?: boolean;
  // The broker listens on TLS only (8883), with a certificate from a throwaway CA the bridge is given
  // via MQTT_CA_FILE (#23). The bridge gets no MQTT_PORT or MQTT_INSECURE, so this is the default
  // configuration: TLS, verified, on 8883. Every other scenario opts out with MQTT_INSECURE=true.
  tls?: boolean;
}

/**
 * A throwaway CA and a server certificate for the broker, made fresh for each run so no private key
 * is ever committed. The SANs cover the broker's name on the test network (for the bridge) and
 * localhost (for this process's test client, via the mapped port).
 */
function makeTestCerts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez12mqtt-tls-'));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'ca.cnf'), [
    '[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=ez12mqtt e2e test CA',
    '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
  ].join('\n'));
  writeFileSync(join(dir, 'server.ext'), [
    'subjectAltName=DNS:mqtt-broker,DNS:localhost,IP:127.0.0.1', 'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
  ].join('\n'));
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'ca.key', '-out', 'ca.pem', '-config', 'ca.cnf', '-extensions', 'v3_ca');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=mqtt-broker');
  openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-out', 'server.pem', '-extfile', 'server.ext');
  return dir;
}

/** Device 1's topic level: its nickname, or its device ID when it has none. */
const deviceTopicOf = (options: TestOptions) => (options.nicknameless ? MOCK_DEVICE_ID : DEVICE_NICKNAME);

async function runTest(options: TestOptions, logOnPass: boolean) {
  if (only && !options.testName.toLowerCase().includes(only)) {
    logger.info(`--- Skipping test: ${options.testName} (--only=${only}) ---`);
    return;
  }
  logger.info(`--- Running test: ${options.testName} ---`);

  const certs = options.tls ? makeTestCerts() : null;
  const brokerPort = certs ? 8883 : 1883;
  // 0o644 on the key too: it's a throwaway, and mosquitto runs as its own unprivileged user.
  const certFile = (name: string, target: string) => ({ source: join(certs!, name), target, mode: 0o644 });

  const network = await new Network().start();
  const mqttContainer = await new GenericContainer('eclipse-mosquitto:2.0.15')
    .withNetwork(network)
    .withNetworkAliases('mqtt-broker')
    .withExposedPorts(brokerPort)
    .withCopyFilesToContainer([
      {
        source: certs ? './tests/test-mosquitto-tls.conf' : './tests/test-mosquitto.conf',
        target: '/mosquitto/config/mosquitto.conf',
      },
      ...(certs ? ['ca.pem', 'server.pem', 'server.key'].map((name) => certFile(name, `/mosquitto/certs/${name}`)) : []),
    ])
    .start();

  const mockImage = await GenericContainer.fromDockerfile(process.cwd(), 'Dockerfile.mock').build();
  const mockContainer = await mockImage
    .withNetwork(network)
    .withNetworkAliases('mock-ez1')
    .withExposedPorts(8050)
    .withEnvironment({
      MOCK_DEVICE_ID: 'E28000000238',
      MOCK_IP_ADDR: 'mock-ez1',
      MOCK_PORT: '8050',
      LOG_LEVEL: 'DEBUG',
    })
    .withWaitStrategy(Wait.forLogMessage('Mock EZ1 API server listening on port 8050'))
    .start();

  const mqttHost = mqttContainer.getHost();
  const mqttPort = mqttContainer.getMappedPort(brokerPort);
  const clientOptions = { host: mqttHost, port: mqttPort, ...(certs && { protocol: 'mqtts' as const, ca: readFileSync(join(certs, 'ca.pem')) }) };

  if (options.prePopulate) {
    logger.info('Pre-populating retained messages...');
    const setupClient = mqtt.connect(clientOptions);
    await new Promise<void>((resolve) => setupClient.on('connect', () => resolve()));
    const infoTopic = `${MQTT_BASE_TOPIC}/${DEVICE_NICKNAME}/info`;
    const infoPayload = {
      deviceIdentifier: 'E28000000238',
      minimumPowerOutput_W: 40,
      maximumPowerOutput_W: 800,
    };
    setupClient.publish(infoTopic, JSON.stringify(infoPayload), { retain: true });

    const offlineInfoTopic = `${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/info`;
    const offlineInfoPayload = {
      deviceIdentifier: 'E28000000OFF',
      minimumPowerOutput_W: 30,
      maximumPowerOutput_W: 900,
    };
    setupClient.publish(offlineInfoTopic, JSON.stringify(offlineInfoPayload), { retain: true });

    const offlineAvailabilityTopic = `${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/availability`;
    setupClient.publish(offlineAvailabilityTopic, '0', { retain: true });

    const offlineEnergyTopic = `${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/energy`;
    const offlineEnergyPayload = {
      observedAt: Math.floor(Date.now() / 1000) - 3600,
      channel1EnergyLifetime_kWh: 123,
      channel2EnergyLifetime_kWh: 456,
      totalEnergyLifetime_kWh: 579,
    };
    setupClient.publish(offlineEnergyTopic, JSON.stringify(offlineEnergyPayload), { retain: true });

    setupClient.end();
    logger.info('Pre-populated retained info message.');
  }

  logger.info('Building ez12mqtt image...');
  const ez12mqttImage = await GenericContainer.fromDockerfile(process.cwd(), 'Dockerfile').build();
  logger.info('Starting ez12mqtt container...');
  const ez12mqttContainer = await ez12mqttImage
    .withNetwork(network)
    .withEnvironment({
      MQTT_HOST: 'mqtt-broker',
      ...(certs ? { MQTT_CA_FILE: '/certs/ca.pem' } : { MQTT_INSECURE: 'true', MQTT_PORT: '1883' }),
      DEVICE_1_IP: 'mock-ez1',
      ...(!options.nicknameless && { DEVICE_1_NICKNAME: DEVICE_NICKNAME }),
      DEVICE_2_IP: '0.0.0.0',
      DEVICE_2_NICKNAME: OFFLINE_DEVICE_NICKNAME,
      HOMEASSISTANT_ENABLE: 'true',
      HOMEASSISTANT_DISCOVERY_PREFIX: HOMEASSISTANT_DISCOVERY_PREFIX,
      LOG_LEVEL: 'DEBUG',
      MQTT_BASE_TOPIC: MQTT_BASE_TOPIC,
      POLL_INTERVAL: '2',
      ...(options.sunNow && {
        LATITUDE: '0',
        LONGITUDE: '0',
        SUN_NOW_OVERRIDE: options.sunNow,
      }),
    })
    .withCopyFilesToContainer(certs ? [certFile('ca.pem', '/certs/ca.pem')] : [])
    .start();

  logger.info('Running assertions...');
  const testClient = mqtt.connect(clientOptions);

  try {
    await runAssertions(testClient, options, ez12mqttContainer);
  } catch (e: unknown) {
    logger.error(`Test failed: ${errorMessage(e)}`);
    throw e;
  } finally {
    if (logOnPass) {
      console.error('--- ez12mqtt container logs (success) ---');
      const logs = await ez12mqttContainer.logs();
      logs.pipe(process.stderr);
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.error('--- end of logs ---');
    }
    await ez12mqttContainer.stop();
    await mockContainer.stop();
    await mqttContainer.stop();
    await network.stop();
    testClient.end();
    if (certs) rmSync(certs, { recursive: true, force: true });
  }
}

function runAssertions(client: MqttClient, options: TestOptions, ez12mqttContainer: StartedTestContainer): Promise<void> {
  return new Promise((resolve, reject) => {
    const deviceTopic = deviceTopicOf(options);
    const pendingAssertions = new Set(
      options.onlySunAssertions
        ? ['ez12mqttOnline']
        : [
            'discoveryComplete',
            'ez12mqttOnline',
            'deviceAvailabilityReceived',
            'deviceStatusOnline',
            'deviceStatusUpdated',
            'maxPowerControlVerified',
            'energyTopicReceived',
          ],
    );

    if (options.sunNow) {
      pendingAssertions.add('sunFieldsPublished');
    }

    if (options.expectOfflineDevice) {
      pendingAssertions.add('device2Offline');
      pendingAssertions.add('device2EnergyRestored');
    }

    logger.info('Waiting for assertions:', { assertions: Array.from(pendingAssertions) });

    async function fail(message: string) {
      logger.error(`Assertion failed: ${message}`);
      if (ez12mqttContainer) {
        console.error('--- ez12mqtt container logs ---');
        const logs = await ez12mqttContainer.logs();
        logs.pipe(process.stderr);
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.error('--- end of logs ---');
      }
      reject(new Error(message));
    }

    function pass(message: string) {
      logger.info(`Assertion passed: ${message}`);
    }

    function checkAllAssertionsPassed() {
      if (pendingAssertions.size === 0) {
        logger.info('All assertions passed!');
        resolve();
      }
    }

    const discoveryWildcard = `${HOMEASSISTANT_DISCOVERY_PREFIX}/#`;

    client.subscribe(discoveryWildcard, (err) => {
      if (err) fail(`Failed to subscribe to discovery topic: ${err.message}`);
      logger.info('Subscribed to discovery topic:', { topic: discoveryWildcard });
    });

    if (options.onlySunAssertions || options.nicknameless) {
      // Sun-down: no device ever comes online, so discovery never fires and the usual
      // subscribe-after-discovery path below never runs. Nickname-less: watch every topic from the
      // start, so a publish to `<base>//…` before the device ID is known can't slip past.
      const wildcard = `${MQTT_BASE_TOPIC}/#`;
      client.subscribe(wildcard, (err) => {
        if (err) fail(`Failed to subscribe to ${wildcard}: ${err.message}`);
        logger.info('Subscribed to base topic:', { topic: wildcard });
      });
    }

    let discoveryMessages = new Map<string, DiscoveryMessage>();
    let stateTopics = new Set<string>();
    let availabilityTopics = new Set<string>();
    let maxPowerStateTopic: string | null = null;
    let maxPowerCommandTopic: string | null = null;
    let firstStatusObservedAt: number | null = null;
    let initialMaxPower: number | null = null;

    client.on('message', (topic, message) => {
      if (options.nicknameless && topic.startsWith(`${MQTT_BASE_TOPIC}//`)) {
        fail(`Published to ${topic}: a device topic was used before its device ID was known (#9).`);
        return;
      }
      const payload = JSON.parse(message.toString());
      logger.debug(`Received message on topic: ${topic}`, { payload });

      if (topic.startsWith(HOMEASSISTANT_DISCOVERY_PREFIX)) {
        if (pendingAssertions.has('discoveryComplete')) {
          if (!payload.unique_id || !payload.name || !payload.device || !payload.device.identifiers) {
            fail(`Invalid discovery payload for topic ${topic}: Missing required fields.`);
          }
  
          const isLifetimeEnergy = topic.includes('EnergyLifetime');
          if (isLifetimeEnergy) {
            if (payload.availability_topic) {
              fail(`Discovery payload for ${topic} should not have availability_topic`);
            }
          } else {
            if (!payload.availability_topic) {
              fail(`Discovery payload for ${topic} is missing availability_topic`);
            }
          }

          discoveryMessages.set(topic, payload);
          logger.debug(`Discovery messages received: ${discoveryMessages.size}/${options.expectedDiscoveryMessages}`);

          if (discoveryMessages.size === options.expectedDiscoveryMessages) {
            pass('All discovery messages received.');
            pendingAssertions.delete('discoveryComplete');

            for (const discovered of discoveryMessages.values()) {
              if (discovered.state_topic) stateTopics.add(discovered.state_topic);
              if (discovered.availability_topic) availabilityTopics.add(discovered.availability_topic);
              if (discovered.name === 'Max Power' && discovered.device.identifiers.includes(MOCK_DEVICE_ID)) {
                maxPowerStateTopic = discovered.state_topic ?? null;
                maxPowerCommandTopic = discovered.command_topic ?? null;
              }
            }

            const energyTopic = `${MQTT_BASE_TOPIC}/${deviceTopic}/energy`;
            const topicsToSubscribe = [...stateTopics, ...availabilityTopics, `${MQTT_BASE_TOPIC}/_status`, energyTopic];
            if (options.expectOfflineDevice) {
              topicsToSubscribe.push(`${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/energy`);
            }
            client.subscribe(topicsToSubscribe, (err) => {
              if (err) fail(`Failed to subscribe to operational topics: ${err.message}`);
              logger.info('Subscribed to operational topics:', { topics: topicsToSubscribe });
            });
          }
        }
      }

      if (
        pendingAssertions.has('sunFieldsPublished') &&
        topic === `${MQTT_BASE_TOPIC}/${deviceTopic}/status`
      ) {
        const missing = ['sunAzimuth_deg', 'sunElevation_deg', 'isSunUp', 'sunriseAt', 'sunsetAt', 'isPollSkipped']
          .filter(k => !(k in payload));
        if (missing.length) {
          fail(`Status payload is missing sun fields: ${missing.join(', ')}`);
        } else if (payload.sunAzimuth_deg < 0 || payload.sunAzimuth_deg >= 360) {
          fail(`sunAzimuth_deg out of range: ${payload.sunAzimuth_deg}`);
        } else if (payload.sunElevation_deg < -90 || payload.sunElevation_deg > 90) {
          fail(`sunElevation_deg out of range: ${payload.sunElevation_deg}`);
        } else if (payload.isPollSkipped !== options.expectPollSkipped) {
          fail(`Expected isPollSkipped=${options.expectPollSkipped}, got ${payload.isPollSkipped}`);
        } else if (payload.isSunUp === options.expectPollSkipped) {
          fail(`isSunUp (${payload.isSunUp}) contradicts isPollSkipped (${payload.isPollSkipped})`);
        } else if (options.expectPollSkipped && payload.totalPower_W !== null) {
          fail(`Poll was skipped but power was reported: ${payload.totalPower_W}`);
        } else {
          pass(`Sun fields published (isSunUp=${payload.isSunUp}, isPollSkipped=${payload.isPollSkipped}).`);
          pendingAssertions.delete('sunFieldsPublished');
          checkAllAssertionsPassed();
        }
      }

      if (topic === `${MQTT_BASE_TOPIC}/_status`) {
        if (payload.online === true) {
          if (pendingAssertions.has('ez12mqttOnline')) {
            pass('ez12mqtt is online.');
            pendingAssertions.delete('ez12mqttOnline');
            checkAllAssertionsPassed();
          }
        }
      }

      if (topic === `${MQTT_BASE_TOPIC}/${deviceTopic}/energy`) {
        if (payload.totalEnergyLifetime_kWh === payload.channel1EnergyLifetime_kWh + payload.channel2EnergyLifetime_kWh) {
          if (pendingAssertions.has('energyTopicReceived')) {
            pass('Energy topic received and validated.');
            pendingAssertions.delete('energyTopicReceived');
            checkAllAssertionsPassed();
          }
        } else {
          fail('Energy topic payload is invalid.');
        }
      }

      if (options.expectOfflineDevice) {
        if (topic === `${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/status`) {
          if (payload.isOnline === false) {
            if (pendingAssertions.has('device2Offline')) {
              pass('Device 2 is offline.');
              pendingAssertions.delete('device2Offline');
              checkAllAssertionsPassed();
            }
          } else {
            fail('Device 2 should be offline.');
          }
        }

        if (topic === `${MQTT_BASE_TOPIC}/${OFFLINE_DEVICE_NICKNAME}/energy`) {
          if (payload.totalEnergyLifetime_kWh === 579) {
            if (pendingAssertions.has('device2EnergyRestored')) {
              pass('Device 2 restored energy topic from retained message.');
              pendingAssertions.delete('device2EnergyRestored');
              checkAllAssertionsPassed();
            }
          } else {
            fail('Device 2 energy topic has incorrect payload.');
          }
        }
      }

      if (topic === maxPowerStateTopic) {
        if (initialMaxPower === null) {
          const initial: number = payload.maximumPowerOutput_W;
          initialMaxPower = initial;
          const newMaxPower = initial - 50;
          logger.info(`Setting max power to ${newMaxPower}`);
          if (maxPowerCommandTopic) client.publish(maxPowerCommandTopic, newMaxPower.toString());
        } else {
          if (payload.maximumPowerOutput_W < initialMaxPower) {
            if (pendingAssertions.has('maxPowerControlVerified')) {
              pass('Max power control verified.');
              pendingAssertions.delete('maxPowerControlVerified');
              checkAllAssertionsPassed();
            }
          }
        }
      }

      if (stateTopics.has(topic) && topic.includes(deviceTopic) && topic !== maxPowerStateTopic) {
        if (payload.isOnline === true && payload.channel1Power_W !== null) {
          if (pendingAssertions.has('deviceStatusOnline')) {
            pass('Device status is online.');
            pendingAssertions.delete('deviceStatusOnline');
            firstStatusObservedAt = payload.observedAt;
            checkAllAssertionsPassed();
          } else {
            if (firstStatusObservedAt && payload.observedAt > firstStatusObservedAt) {
              if (pendingAssertions.has('deviceStatusUpdated')) {
                pass('Device status is updating.');
                pendingAssertions.delete('deviceStatusUpdated');
                checkAllAssertionsPassed();
              }
            }
          }
        }
      }

      if (availabilityTopics.has(topic) && topic.includes(deviceTopic)) {
        if (payload === 1 || payload.toString() === '1') {
          if (pendingAssertions.has('deviceAvailabilityReceived')) {
            pass('Device availability is online.');
            pendingAssertions.delete('deviceAvailabilityReceived');
            checkAllAssertionsPassed();
          }
        }
      }
    });

    setTimeout(() => {
      for (const assertion of pendingAssertions) {
        fail(`Timeout waiting for: ${assertion}`);
        return;
      }
    }, ASSERTION_TIMEOUT);
  });
}

async function main() {
  try {
    await runTest({
      testName: 'Pre-populated Broker',
      prePopulate: true,
      expectedDiscoveryMessages: 28,
      expectOfflineDevice: true,
    }, logOnPass);
    await runTest({
      testName: 'Empty Broker',
      prePopulate: false,
      expectedDiscoveryMessages: 14,
      expectOfflineDevice: false,
      // Local noon at Null Island: sun up, so this is normal operation plus proof the sun
      // fields ride along without disturbing it.
      sunNow: '2026-06-21T12:00:00Z',
      expectPollSkipped: false,
    }, logOnPass);
    await runTest({
      testName: 'No Nickname (topic is the device ID)',
      prePopulate: false,
      expectedDiscoveryMessages: 14,
      expectOfflineDevice: false,
      nicknameless: true,
    }, logOnPass);
    await runTest({
      testName: 'TLS Broker (mqtts with a private CA)',
      prePopulate: false,
      expectedDiscoveryMessages: 14,
      expectOfflineDevice: false,
      tls: true,
    }, logOnPass);
    await runTest({
      testName: 'Sun Down (polling skipped)',
      prePopulate: false,
      expectedDiscoveryMessages: 0,
      expectOfflineDevice: false,
      // Local midnight at Null Island.
      sunNow: '2026-06-21T00:00:00Z',
      expectPollSkipped: true,
      onlySunAssertions: true,
    }, logOnPass);
  } catch (e) {
    logger.error('A test failed, exiting.');
    process.exit(1);
  }
}

main();
