import config from './config.ts';
import { logger } from './logger.ts';
import { EZ1API } from './api.ts';
import { MQTTClient } from './mqtt.ts';

interface DeviceState {
  ip: string;
  nickname?: string;
  description?: string;
  deviceId?: string; // Fetched from getDeviceInfo
  mqttTopic: string; // Base topic for this device
  isOnline: boolean;
  lastSeenAt: number | null; // Unix timestamp
  infoPublished: boolean; // To track if info topic has been published at least once
}

const mqttClient = new MQTTClient();
const deviceStates: DeviceState[] = [];

// Initialize device states from config
config.devices.forEach(deviceConfig => {
  deviceStates.push({
    ...deviceConfig,
    mqttTopic: deviceConfig.nickname || '', // Will be updated with deviceId if nickname is not present
    isOnline: false,
    lastSeenAt: null,
    infoPublished: false,
  });
});

async function fetchAndPublishInfo(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const deviceInfo = await api.getDeviceInfo();
  const maxPower = await api.getMaxPower();

  if (deviceInfo && maxPower) {
    deviceState.deviceId = deviceInfo.deviceId;
    if (!deviceState.nickname) {
      deviceState.mqttTopic = deviceInfo.deviceId;
    }

    const payload = {
      observedAt: Math.floor(Date.now() / 1000),
      deviceIdentifier: deviceInfo.deviceId,
      deviceVersion: deviceInfo.devVer,
      wifiNetworkSSID: deviceInfo.ssid,
      deviceIPAddress: deviceInfo.ipAddr,
      minimumPowerOutput_W: parseFloat(deviceInfo.minPower),
      maximumPowerOutput_W: parseFloat(maxPower.power),
      deviceDescription: deviceState.description,
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/info`, payload, true);
    deviceState.infoPublished = true;
  }
}

async function fetchAndPublishStatus(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const outputData = await api.getOutputData();
  const alarmInfo = await api.getAlarm();

  if (outputData) {
    deviceState.isOnline = true;
    deviceState.lastSeenAt = Math.floor(Date.now() / 1000);
  } else {
    deviceState.isOnline = false;
  }

  const payload: any = {
    observedAt: Math.floor(Date.now() / 1000),
    isOnline: deviceState.isOnline,
    deviceLastSeenAt: deviceState.lastSeenAt,
  };

  if (outputData) {
    payload.channel1Power_W = outputData.p1;
    payload.channel1EnergyToday_kWh = outputData.e1;
    payload.channel1EnergyLifetime_kWh = outputData.te1;
    payload.channel2Power_W = outputData.p2;
    payload.channel2EnergyToday_kWh = outputData.e2;
    payload.channel2EnergyLifetime_kWh = outputData.te2;
  } else {
    payload.channel1Power_W = null;
    payload.channel1EnergyToday_kWh = null;
    payload.channel1EnergyLifetime_kWh = null;
    payload.channel2Power_W = null;
    payload.channel2EnergyToday_kWh = null;
    payload.channel2EnergyLifetime_kWh = null;
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

  if (deviceState.isOnline && !wasOnline) {
    logger.info(`Device ${deviceState.ip} is now online. Fetching info.`);
    await fetchAndPublishInfo(deviceState);
  } else if (!deviceState.isOnline && wasOnline) {
    logger.warn(`Device ${deviceState.ip} went offline.`);
    // The offline status is already published by fetchAndPublishStatus
  }
}

async function main(): Promise<void> {
  mqttClient.connect();

  // Initial fetch for all devices
  for (const deviceState of deviceStates) {
    await fetchAndPublishInfo(deviceState);
    await fetchAndPublishStatus(deviceState);
  }

  // Set up polling interval
  setInterval(async () => {
    for (const deviceState of deviceStates) {
      await pollDevice(deviceState);
    }
  }, config.pollInterval * 1000);
}

main().catch(error => {
  logger.error('Application crashed:', { error: error.message, stack: error.stack });
  process.exit(1);
});
