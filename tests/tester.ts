import * as mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import config from '../src/config.ts';
import { logger } from '../src/logger.ts';

const ASSERTION_TIMEOUT = 30 * 1000; // 30 seconds per assertion

let client: MqttClient;

const EXPECTED_DISCOVERY_MESSAGES = 10;

const state = {
  ez12mqttOnline: false,
  deviceStatusOnline: false,
  deviceStatusUpdated: false,
  deviceAvailabilityReceived: false,
  discoveryComplete: false,
};

let discoveryMessages = new Set<string>();
let stateTopics = new Set<string>();
let availabilityTopics = new Set<string>();

function fail(message: string) {
  logger.error(`Assertion failed: ${message}`);
  client.end();
  process.exit(1);
}

function pass(message: string) {
  logger.info(`Assertion passed: ${message}`);
}

function checkAllAssertionsPassed() {
  logger.debug('Checking all assertions:', { state });
  if (Object.values(state).every(Boolean)) {
    logger.info('All assertions passed!');
    client.end();
    process.exit(0);
  }
}

function runAssertions() {
  const discoveryPrefix = config.homeAssistantDiscoveryPrefix;
  const discoveryWildcard = `${discoveryPrefix}/#`;

  client.subscribe(discoveryWildcard, (err) => {
    if (err) {
      fail(`Failed to subscribe to discovery topic: ${err.message}`);
    }
    logger.info('Subscribed to discovery topic:', { topic: discoveryWildcard });
  });

  let firstStatusObservedAt: number | null = null;

  client.on('message', (topic, message) => {
    const payload = JSON.parse(message.toString());
    logger.debug(`Received message on topic: ${topic}`, { payload });

    if (topic.startsWith(discoveryPrefix)) {
      if (!state.discoveryComplete) {
        discoveryMessages.add(topic);
        if (payload.state_topic) stateTopics.add(payload.state_topic);
        if (payload.availability_topic) availabilityTopics.add(payload.availability_topic);

        if (discoveryMessages.size === EXPECTED_DISCOVERY_MESSAGES) {
          pass('All discovery messages received.');
          state.discoveryComplete = true;

          const topicsToSubscribe = [...stateTopics, ...availabilityTopics, `${config.mqttBaseTopic}/_status`];
          client.subscribe(topicsToSubscribe, (err) => {
            if (err) {
              fail(`Failed to subscribe to operational topics: ${err.message}`);
            }
            logger.info('Subscribed to operational topics:', { topics: topicsToSubscribe });
          });
        }
      }
    }

    if (topic === `${config.mqttBaseTopic}/_status`) {
      if (payload.online === true && payload.uptime_s >= 0) {
        if (!state.ez12mqttOnline) {
          pass('ez12mqtt is online.');
          state.ez12mqttOnline = true;
          checkAllAssertionsPassed();
        }
      } else {
        fail('ez12mqtt reported as offline or uptime is missing.');
      }
    }

    if (stateTopics.has(topic)) {
      if (payload.isOnline === true && payload.channel1Power_W !== null) {
        if (!state.deviceStatusOnline) {
          pass('Device status is online.');
          state.deviceStatusOnline = true;
          firstStatusObservedAt = payload.observedAt;
          checkAllAssertionsPassed();
        } else {
          if (firstStatusObservedAt && payload.observedAt > firstStatusObservedAt) {
            if (!state.deviceStatusUpdated) {
              pass('Device status is updating.');
              state.deviceStatusUpdated = true;
              checkAllAssertionsPassed();
            }
          }
        }
      } else if (state.discoveryComplete) {
        fail('Device status reported as offline.');
      }
    }

    if (availabilityTopics.has(topic)) {
      if (payload === 1) {
        if (!state.deviceAvailabilityReceived) {
          pass('Device availability is online.');
          state.deviceAvailabilityReceived = true;
          checkAllAssertionsPassed();
        }
      } else {
        fail(`Device availability reported as offline or invalid: ${payload}`);
      }
    }
  });

  // Timeout for the entire test suite
  setTimeout(() => {
    if (!state.discoveryComplete) fail('Timeout waiting for discovery messages.');
    if (!state.ez12mqttOnline) fail('Timeout waiting for ez12mqtt to come online.');
    if (!state.deviceStatusOnline) fail('Timeout waiting for device status.');
    if (!state.deviceStatusUpdated) fail('Timeout waiting for device status update.');
    if (!state.deviceAvailabilityReceived) fail('Timeout waiting for device availability.');
  }, ASSERTION_TIMEOUT);
}

function connect() {
  const options: IClientOptions = {
    clientId: `mqtt_tester_${Math.random().toString(16).slice(3)}`,
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 1000,
  };

  logger.info(`Connecting to MQTT broker at mqtt://${config.mqttHost}:${config.mqttPort}`);
  client = mqtt.connect(`mqtt://${config.mqttHost}:${config.mqttPort}`, options);

  client.on('connect', () => {
    logger.info('Connected to MQTT broker.');
    runAssertions();
  });

  client.on('error', (error) => {
    logger.error(`MQTT connection error: ${error.message}`);
    // Keep trying to connect
  });
}

// Wait for a few seconds for ez12mqtt to start up
setTimeout(connect, 5000);
