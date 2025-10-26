import * as mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import config from '../src/config.ts';
import { logger } from '../src/logger.ts';

const ASSERTION_TIMEOUT = 30 * 1000; // 30 seconds per assertion

let client: MqttClient;

const state = {
  ez12mqttOnline: false,
  deviceInfoReceived: false,
  deviceStatusOnline: false,
  deviceStatusUpdated: false,
};

function fail(message: string) {
  logger.error(`Assertion failed: ${message}`);
  client.end();
  process.exit(1);
}

function pass(message: string) {
  logger.info(`Assertion passed: ${message}`);
}

function checkAllAssertionsPassed() {
  if (Object.values(state).every(Boolean)) {
    logger.info('All assertions passed!');
    client.end();
    process.exit(0);
  }
}

function runAssertions() {
  const topics = [
    `${config.mqttBaseTopic}/_status`,
    `${config.mqttBaseTopic}/${config.devices[0].nickname || ''}/info`,
    `${config.mqttBaseTopic}/${config.devices[0].nickname || ''}/status`,
  ];

  client.subscribe(topics, (err) => {
    if (err) {
      fail(`Failed to subscribe to topics: ${err.message}`);
    }
    logger.info('Subscribed to topics:', { topics });
  });

  let firstStatusObservedAt: number | null = null;

  client.on('message', (topic, message) => {
    const payload = JSON.parse(message.toString());
    logger.debug(`Received message on topic: ${topic}`, { payload });

    // Assertion 1: ez12mqtt is online
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

    // Assertion 2: Device info is published
    if (topic === `${config.mqttBaseTopic}/${config.devices[0].nickname}/info`) {
      if (payload.deviceIdentifier && payload.deviceDescription && payload.maximumPowerOutput_W) {
        if (!state.deviceInfoReceived) {
          pass('Device info received.');
          state.deviceInfoReceived = true;
          checkAllAssertionsPassed();
        }
      } else {
        fail('Device info payload is invalid.');
      }
    }

    // Assertion 3 & 4: Device status is published, online, and updating
    if (topic === `${config.mqttBaseTopic}/${config.devices[0].nickname}/status`) {
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
      } else if (state.deviceInfoReceived) { // Only fail if we have already received info
        fail('Device status reported as offline.');
      }
    }
  });

  // Timeout for the entire test suite
  setTimeout(() => {
    if (!state.ez12mqttOnline) fail('Timeout waiting for ez12mqtt to come online.');
    if (!state.deviceInfoReceived) fail('Timeout waiting for device info.');
    if (!state.deviceStatusOnline) fail('Timeout waiting for device status.');
    if (!state.deviceStatusUpdated) fail('Timeout waiting for device status update.');
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
