import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { GenericContainer, Network, Wait } from 'testcontainers';
import { logger } from '../src/logger.ts';

const ASSERTION_TIMEOUT = 60 * 1000; // 60 seconds

const EXPECTED_DISCOVERY_MESSAGES = 14;

const MQTT_BASE_TOPIC = 'ez12mqtt_test';
const DEVICE_NICKNAME = 'mock_inverter';
const HOMEASSISTANT_DISCOVERY_PREFIX = 'homeassistant';

const state = {
  discoveryComplete: false,
  ez12mqttOnline: false,
  deviceAvailabilityReceived: false,
  deviceStatusOnline: false,
  deviceStatusUpdated: false,
  maxPowerControlVerified: false,
};

function fail(client: MqttClient, message: string) {
  logger.error(`Assertion failed: ${message}`);
  client.end();
  process.exit(1);
}

function pass(message: string) {
  logger.info(`Assertion passed: ${message}`);
}

function checkAllAssertionsPassed(client: MqttClient) {
  logger.debug('Checking all assertions:', { state });
  if (Object.values(state).every(Boolean)) {
    logger.info('All assertions passed!');
    client.end();
    process.exit(0);
  }
}

async function main() {
  logger.info('Starting e2e test with Testcontainers...');

  const network = await new Network().start();

  // 1. Start MQTT Broker Container
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

  // 2. Start Mock EZ1 Server Container
  const mockContainer = await new GenericContainer('ghcr.io/junosuarez/ez12mqtt:latest-mock')
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

  // 3. Pre-populate retained message
  const setupClient = mqtt.connect({ host: mqttHost, port: mqttPort });
  await new Promise<void>((resolve) => setupClient.on('connect', () => resolve()));
  const infoTopic = `${MQTT_BASE_TOPIC}/${DEVICE_NICKNAME}/info`;
  const infoPayload = {
    deviceIdentifier: 'E28000000238',
    minimumPowerOutput_W: 40,
    maximumPowerOutput_W: 800,
  };
  setupClient.publish(infoTopic, JSON.stringify(infoPayload), { retain: true });
  setupClient.end();
  logger.info('Pre-populated retained info message.');

  // 4. Start ez12mqtt Container
  const ez12mqttContainer = await new GenericContainer('ghcr.io/junosuarez/ez12mqtt:latest')
    .withNetwork(network)
    .withEnvironment({
      MQTT_HOST: 'mqtt-broker',
      MQTT_PORT: '1883',
      DEVICE_1_IP: 'mock-ez1',
      DEVICE_1_NICKNAME: DEVICE_NICKNAME,
      HOMEASSISTANT_ENABLE: 'true',
      HOMEASSISTANT_DISCOVERY_PREFIX: HOMEASSISTANT_DISCOVERY_PREFIX,
      LOG_LEVEL: 'DEBUG',
      MQTT_BASE_TOPIC: MQTT_BASE_TOPIC,
    })
    .start();

  // 5. Run Assertions
  const testClient = mqtt.connect({ host: mqttHost, port: mqttPort });
  runTestAssertions(testClient);

  // Teardown
  const teardown = async () => {
    await ez12mqttContainer.stop();
    await mockContainer.stop();
    await mqttContainer.stop();
    await network.stop();
  };

  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}

function runTestAssertions(client: MqttClient) {
  const discoveryWildcard = `${HOMEASSISTANT_DISCOVERY_PREFIX}/#`;

  client.subscribe(discoveryWildcard, (err) => {
    if (err) fail(client, `Failed to subscribe to discovery topic: ${err.message}`);
    logger.info('Subscribed to discovery topic:', { topic: discoveryWildcard });
  });

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
      if (!state.discoveryComplete) {
        // Validate the discovery payload
        if (!payload.unique_id || !payload.name || !payload.device || !payload.device.identifiers || !payload.availability_topic) {
          fail(client, `Invalid discovery payload for topic ${topic}: Missing required fields.`);
        }
        const componentType = topic.split('/')[1];
        if (componentType === 'sensor' || componentType === 'binary_sensor') {
          if (!payload.state_topic || !payload.value_template) {
            fail(client, `Invalid discovery payload for ${componentType} ${topic}: Missing state_topic or value_template.`);
          }
        }
        if (componentType === 'number') {
          if (!payload.command_topic || !payload.state_topic) {
            fail(client, `Invalid discovery payload for ${componentType} ${topic}: Missing command_topic or state_topic.`);
          }
        }

        discoveryMessages.set(topic, payload);

        if (discoveryMessages.size === EXPECTED_DISCOVERY_MESSAGES) {
          pass('All discovery messages received.');
          state.discoveryComplete = true;

          for (const discovered of discoveryMessages.values()) {
            if (discovered.state_topic) stateTopics.add(discovered.state_topic);
            if (discovered.availability_topic) availabilityTopics.add(discovered.availability_topic);
            if (discovered.name === 'Max Power') {
              maxPowerStateTopic = discovered.state_topic;
              maxPowerCommandTopic = discovered.command_topic;
            }
          }

          const topicsToSubscribe = [...stateTopics, ...availabilityTopics, `${MQTT_BASE_TOPIC}/_status`];
          client.subscribe(topicsToSubscribe, (err) => {
            if (err) fail(client, `Failed to subscribe to operational topics: ${err.message}`);
            logger.info('Subscribed to operational topics:', { topics: topicsToSubscribe });
          });
        }
      }
    }

    if (topic === `${MQTT_BASE_TOPIC}/_status`) {
      if (payload.online === true && payload.uptime_s >= 0) {
        if (!state.ez12mqttOnline) {
          pass('ez12mqtt is online.');
          state.ez12mqttOnline = true;
          checkAllAssertionsPassed(client);
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
          pass('Max power control verified.');
          state.maxPowerControlVerified = true;
          checkAllAssertionsPassed(client);
        }
      }
    }

    if (stateTopics.has(topic) && topic !== maxPowerStateTopic) {
      if (payload.isOnline === true && payload.channel1Power_W !== null) {
        if (!state.deviceStatusOnline) {
          pass('Device status is online.');
          state.deviceStatusOnline = true;
          firstStatusObservedAt = payload.observedAt;
          checkAllAssertionsPassed(client);
        } else {
          if (firstStatusObservedAt && payload.observedAt > firstStatusObservedAt) {
            if (!state.deviceStatusUpdated) {
              pass('Device status is updating.');
              state.deviceStatusUpdated = true;
              checkAllAssertionsPassed(client);
            }
          }
        }
      }
    }

    if (availabilityTopics.has(topic)) {
      if (payload === 1 || payload.toString() === '1') {
        if (!state.deviceAvailabilityReceived) {
          pass('Device availability is online.');
          state.deviceAvailabilityReceived = true;
          checkAllAssertionsPassed(client);
        }
      }
    }
  });

  setTimeout(() => {
    Object.keys(state).forEach(key => {
      if (!state[key as keyof typeof state]) {
        fail(client, `Timeout waiting for: ${key}`);
      }
    });
  }, ASSERTION_TIMEOUT);
}

main();
