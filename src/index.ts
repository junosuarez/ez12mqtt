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
    deviceState.isOnline = true;
    deviceState.lastSeenAt = Math.floor(Date.now() / 1000);
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
      minimumPowerOutput: parseFloat(deviceInfo.minPower),
      maximumPowerOutput: parseFloat(maxPower.power),
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/info`, payload);
    deviceState.infoPublished = true;
  } else {
    // Device is offline or info not available
    if (deviceState.isOnline) {
      logger.warn(`Device ${deviceState.ip} went offline.`);
      deviceState.isOnline = false;
      // Re-publish info with offline status if it was previously online
      if (deviceState.infoPublished) {
        const offlinePayload = {
          observedAt: Math.floor(Date.now() / 1000),
          deviceIdentifier: deviceState.deviceId || 'unknown',
          deviceStatus: 'offline',
        };
        mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/info`, offlinePayload);
      }
    }
  }
}

async function fetchAndPublishStatus(deviceState: DeviceState): Promise<void> {
  const api = new EZ1API(deviceState.ip);
  const outputData = await api.getOutputData();
  const alarmInfo = await api.getAlarm();

  const payload: any = {
    observedAt: Math.floor(Date.now() / 1000),
    isOnline: deviceState.isOnline,
    deviceLastSeenAt: deviceState.lastSeenAt,
  };

  if (outputData) {
    payload.channel1Power = outputData.p1;
    payload.channel1EnergyToday = outputData.e1;
    payload.channel1EnergyLifetime = outputData.te1;
    payload.channel2Power = outputData.p2;
    payload.channel2EnergyToday = outputData.e2;
    payload.channel2EnergyLifetime = outputData.te2;
  } else {
    // If outputData is null, but device was online, it means it just went offline
    // or there was a temporary API issue. We still want to publish last known energy lifetime.
    // For simplicity, we'll just set these to null if not available.
    payload.channel1Power = null;
    payload.channel1EnergyToday = null;
    payload.channel1EnergyLifetime = null; // This should ideally retain last known value if device is offline
    payload.channel2Power = null;
    payload.channel2EnergyToday = null;
    payload.channel2EnergyLifetime = null; // This should ideally retain last known value if device is offline
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

  // Check if device is online and publish info if not already done or if status changed
  const wasOnline = deviceState.isOnline;
  await fetchAndPublishInfo(deviceState);

  if (deviceState.isOnline) {
    if (!wasOnline) {
      logger.info(`Device ${deviceState.ip} is now online. Re-fetching info.`);
      await fetchAndPublishInfo(deviceState); // Re-fetch info if device just came online
    }
    await fetchAndPublishStatus(deviceState);
  } else {
    // If device is offline, publish an offline status message
    const payload: any = {
      observedAt: Math.floor(Date.now() / 1000),
      isOnline: false,
      deviceLastSeenAt: deviceState.lastSeenAt,
      // All other status fields will be null or last known if applicable
      channel1Power: null,
      channel1EnergyToday: null,
      channel1EnergyLifetime: null, // This should ideally retain last known value if device is offline
      channel2Power: null,
      channel2EnergyToday: null,
      channel2EnergyLifetime: null, // This should ideally retain last known value if device is offline
      isOffGrid: null,
      isOutputFault: null,
      isChannel1ShortCircuit: null,
      isChannel2ShortCircuit: null,
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/status`, payload);
  }
}

async function main(): Promise<void> {
  mqttClient.connect();

  // Initial fetch for all devices
  for (const deviceState of deviceStates) {
    await pollDevice(deviceState);
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
