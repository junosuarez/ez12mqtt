import config from './config.ts';
import { logger } from './logger.ts';
import { EZ1API } from './api.ts';
import { MQTTClient } from './mqtt.ts';

import { publishDiscoveryMessages } from './homeassistant.ts';

export interface DeviceState {
  ip: string;
  nickname?: string;
  description?: string;
  deviceId?: string; // Fetched from getDeviceInfo
  mqttTopic: string; // Base topic for this device
  isOnline: boolean;
  lastSeenAt: number | null; // Unix timestamp
  infoPublished: boolean; // To track if info topic has been published at least once
  discoveryPublished: boolean; // To track if discovery messages have been published
  minPower?: number;
  maxPower?: number;
}

const mqttClient = new MQTTClient();
const deviceStates: DeviceState[] = [];

// Initialize device states from config
config.devices.forEach(deviceConfig => {
  deviceStates.push({
    ...deviceConfig,
    mqttTopic: deviceConfig.nickname || '',
    isOnline: false,
    lastSeenAt: null,
    infoPublished: false,
    discoveryPublished: false,
  });
});

async function fetchAndPublishInfo(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const deviceInfo = await api.getDeviceInfo();

  if (deviceInfo) {
    deviceState.deviceId = deviceInfo.deviceId;
    if (!deviceState.nickname) {
      deviceState.mqttTopic = deviceInfo.deviceId;
    }

    deviceState.minPower = parseFloat(deviceInfo.minPower);

    const payload = {
      observedAt: Math.floor(Date.now() / 1000),
      deviceIdentifier: deviceInfo.deviceId,
      deviceVersion: deviceInfo.devVer,
      wifiNetworkSSID: deviceInfo.ssid,
      deviceIPAddress: deviceInfo.ipAddr,
      minimumPowerOutput_W: deviceState.minPower,
      deviceDescription: deviceState.description,
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/info`, payload, true);
    logger.debug(`Published info topic for ${deviceState.mqttTopic}`, { payload });
    deviceState.infoPublished = true;
  }
}

async function fetchAndPublishMaxPower(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const maxPower = await api.getMaxPower();

  if (maxPower) {
    deviceState.maxPower = parseFloat(maxPower.power);
    const payload = {
      observedAt: Math.floor(Date.now() / 1000),
      maximumPowerOutput_W: deviceState.maxPower,
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/maxPower_W`, payload, true);
    logger.debug(`Published maxPower_W topic for ${deviceState.mqttTopic}`, { payload });
  }
}

async function fetchAndPublishStatus(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const outputData = await api.getOutputData();
  const alarmInfo = await api.getAlarm();

  const wasOnline = deviceState.isOnline;
  deviceState.isOnline = !!outputData;

  if (deviceState.isOnline) {
    deviceState.lastSeenAt = Math.floor(Date.now() / 1000);
  }

  if (deviceState.isOnline !== wasOnline) {
    mqttClient.publishRaw(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`, deviceState.isOnline ? '1' : '0', true);
  }

  const payload: any = {
    observedAt: Math.floor(Date.now() / 1000),
    isOnline: deviceState.isOnline,
    deviceLastSeenAt: deviceState.lastSeenAt,
  };

  if (outputData) {
    payload.channel1Power_W = outputData.p1;
    payload.channel1EnergySinceStartup_kWh = outputData.e1;
    payload.channel1EnergyLifetime_kWh = outputData.te1;
    payload.channel2Power_W = outputData.p2;
    payload.channel2EnergySinceStartup_kWh = outputData.e2;
    payload.channel2EnergyLifetime_kWh = outputData.te2;
    payload.totalPower_W = outputData.p1 + outputData.p2;
    payload.totalEnergySinceStartup_kWh = outputData.e1 + outputData.e2;
    payload.totalEnergyLifetime_kWh = outputData.te1 + outputData.te2;
  } else {
    payload.channel1Power_W = null;
    payload.channel1EnergySinceStartup_kWh = null;
    payload.channel1EnergyLifetime_kWh = null;
    payload.channel2Power_W = null;
    payload.channel2EnergySinceStartup_kWh = null;
    payload.channel2EnergyLifetime_kWh = null;
    payload.totalPower_W = null;
    payload.totalEnergySinceStartup_kWh = null;
    payload.totalEnergyLifetime_kWh = null;
  }

  if (alarmInfo) {
    payload.isOffGrid = alarmInfo.og === '1';
    payload.isOutputFault = alarmInfo.oe === '1';
    payload.isChannel1ShortCircuit = alarmInfo.isce1 === '1';
    payload.isChannel2ShortCircuit = alarmInfo.isce2 === '1';
  } else {
    payload.isOffGrid = null;
    payload.isOutputFault = null;
    payload.isChannel1ShortCircuit = null;
    payload.isChannel2ShortCircuit = null;
  }

  mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/status`, payload);
}

async function pollDevice(deviceState: DeviceState): Promise<void> {
  logger.debug(`Polling device: ${deviceState.ip}`);

  const wasOnline = deviceState.isOnline;
  await fetchAndPublishStatus(deviceState);
  if (deviceState.isOnline) {
    await fetchAndPublishMaxPower(deviceState);
  }

  if (deviceState.isOnline && !wasOnline) {
    logger.info(`Device ${deviceState.ip} is now online. Fetching info.`);
    await fetchAndPublishInfo(deviceState);
    await fetchAndPublishMaxPower(deviceState);
    if (config.homeAssistantEnable && !deviceState.discoveryPublished) {
      publishDiscoveryMessages(deviceState, mqttClient);
      deviceState.discoveryPublished = true;
    }
  } else if (!deviceState.isOnline && wasOnline) {
    logger.warn(`Device ${deviceState.ip} went offline.`);
  }
}

async function main(): Promise<void> {
  mqttClient.connect((topic, message) => {
    const messageString = message.toString();
    logger.debug(`Received message on topic: ${topic}`, { payload: messageString });

    const setMaxPowerRegex = new RegExp(`^${config.mqttBaseTopic}/(.+)/maxPower_W/set$`);
    const match = topic.match(setMaxPowerRegex);

    if (match) {
      const deviceTopic = match[1];
      const deviceState = deviceStates.find(d => d.mqttTopic === deviceTopic);

      if (deviceState) {
        const power = parseInt(messageString, 10);
        if (!isNaN(power) && deviceState.minPower && deviceState.maxPower && power >= deviceState.minPower && power <= deviceState.maxPower) {
          logger.info(`Setting max power for ${deviceTopic} to ${power}`);
          const api = new EZ1API(deviceState.ip);
          api.setMaxPower(power).then(() => {
            logger.debug(`setMaxPower successful for ${deviceTopic}. Re-publishing maxPower topic.`);
            fetchAndPublishMaxPower(deviceState);
          }).catch(error => {
            logger.error(`Failed to set max power for ${deviceTopic}: ${error.message}`);
          });
        } else {
          logger.warn(`Invalid power value received for ${deviceTopic}: ${messageString}`);
        }
      } else {
        logger.warn(`Received setMaxPower command for unknown device: ${deviceTopic}`);
      }
    }
  });

  // Initial poll for all devices
  for (const deviceState of deviceStates) {
    await pollDevice(deviceState);
    if (config.homeAssistantEnable) {
      mqttClient.subscribe(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/maxPower_W/set`);
    }
  }

  // Set up polling interval
  setInterval(async () => {
    for (const deviceState of deviceStates) {
      await pollDevice(deviceState);
    }
  }, config.pollInterval * 1000);
}

function shutdown() {
  logger.info('Shutting down...');
  for (const deviceState of deviceStates) {
    if (deviceState.isOnline) {
      mqttClient.publishRaw(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`, '0', true);
    }
  }
  mqttClient.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(error => {
  logger.error('Application crashed:', { error: error.message, stack: error.stack });
  process.exit(1);
});
