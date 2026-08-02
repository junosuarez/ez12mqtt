import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { GenericContainer, Network, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { logger } from '../src/logger.ts';

// Note: It is never correct to increase this timeout. A timeout error always indicates a correctness bug.
const ASSERTION_TIMEOUT = 60 * 1000;

const MQTT_BASE_TOPIC = 'ez12mqtt_test';
const DEVICE_NICKNAME = 'mock_inverter';
const OFFLINE_DEVICE_NICKNAME = 'offline_inverter';
const HOMEASSISTANT_DISCOVERY_PREFIX = 'homeassistant';

const logOnPass = process.argv.includes('--log-on-pass');

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
}

async function runTest(options: TestOptions, logOnPass: boolean) {
  logger.info(`--- Running test: ${options.testName} ---`);

  const network = await new Network().start();
  const mqttContainer = await new GenericContainer('eclipse-mosquitto:2.0.15')
    .withNetwork(network)
    .withNetworkAliases('mqtt-broker')
    .withExposedPorts(1883)
    .withCopyFilesToContainer([
      {
        source: './tests/test-mosquitto.conf',
        target: '/mosquitto/config/mosquitto.conf',
      },
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
  const mqttPort = mqttContainer.getMappedPort(1883);

  if (options.prePopulate) {
    logger.info('Pre-populating retained messages...');
    const setupClient = mqtt.connect({ host: mqttHost, port: mqttPort });
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
      MQTT_PORT: '1883',
      DEVICE_1_IP: 'mock-ez1',
      DEVICE_1_NICKNAME: DEVICE_NICKNAME,
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
    .start();

  logger.info('Running assertions...');
  const testClient = mqtt.connect({ host: mqttHost, port: mqttPort });

  try {
    await runAssertions(testClient, options, ez12mqttContainer);
  } catch (e: any) {
    logger.error(`Test failed: ${e.message}`);
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
  }
}

function runAssertions(client: MqttClient, options: TestOptions, ez12mqttContainer: StartedTestContainer): Promise<void> {
  return new Promise((resolve, reject) => {
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

    logger.info('Waiting for assertions:', Array.from(pendingAssertions));

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

    if (options.onlySunAssertions) {
      // No device ever comes online here, so discovery never fires and the usual
      // subscribe-after-discovery path below never runs.
      const wildcard = `${MQTT_BASE_TOPIC}/#`;
      client.subscribe(wildcard, (err) => {
        if (err) fail(`Failed to subscribe to ${wildcard}: ${err.message}`);
        logger.info('Subscribed to base topic:', { topic: wildcard });
      });
    }

    let discoveryMessages = new Map<string, any>();
    let stateTopics = new Set<string>();
    let availabilityTopics = new Set<string>();
    let maxPowerStateTopic: string | null = null;
    let maxPowerCommandTopic: string | null = null;
    let firstStatusObservedAt: number | null = null;
    let initialMaxPower: number | null = null;

    client.on('message', (topic, message) => {
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
              if (discovered.name === 'Max Power' && discovered.device.identifiers.includes('E28000000238')) {
                maxPowerStateTopic = discovered.state_topic;
                maxPowerCommandTopic = discovered.command_topic;
              }
            }

            const energyTopic = `${MQTT_BASE_TOPIC}/${DEVICE_NICKNAME}/energy`;
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
        topic === `${MQTT_BASE_TOPIC}/${DEVICE_NICKNAME}/status`
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

      if (topic === `${MQTT_BASE_TOPIC}/${DEVICE_NICKNAME}/energy`) {
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
          initialMaxPower = payload.maximumPowerOutput_W;
          const newMaxPower = initialMaxPower - 50;
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

      if (stateTopics.has(topic) && topic.includes(DEVICE_NICKNAME) && topic !== maxPowerStateTopic) {
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

      if (availabilityTopics.has(topic) && topic.includes(DEVICE_NICKNAME)) {
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
