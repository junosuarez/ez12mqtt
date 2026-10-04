import config from './config.ts';
import { errorMessage, logger } from './logger.ts';
import { recordDeviceOnline, recordPollError, recordPollSuccess, startMetricsServer } from './metrics.ts';
import { EZ1API, type AlarmInfo, type OutputData } from './api.ts';
import { MQTTClient } from './mqtt.ts';

import { publishDiscoveryMessages } from './homeassistant.ts';
import { getSunState, type SunState } from './sun.ts';

/** Null when no location is configured; the app then polls around the clock as before. */
function currentSun(): SunState | null {
  if (config.latitude === undefined || config.longitude === undefined) return null;
  return getSunState(config.latitude, config.longitude, config.sunElevationThreshold, config.sunNowOverride);
}

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
let metricsServer: ReturnType<typeof startMetricsServer> = null;

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
    if (!deviceState.nickname && deviceState.mqttTopic !== deviceInfo.deviceId) {
      deviceState.mqttTopic = deviceInfo.deviceId;
      // onMqttConnected could not subscribe for a topic it did not know yet.
      if (config.homeAssistantEnable) {
        mqttClient.subscribe(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/maxPower_W/set`);
      }
    }

    deviceState.minPower = parseFloat(deviceInfo.minPower);
    deviceState.maxPower = parseFloat(deviceInfo.maxPower);

    const payload = {
      observedAt: Math.floor(Date.now() / 1000),
      deviceIdentifier: deviceInfo.deviceId,
      deviceVersion: deviceInfo.devVer,
      wifiNetworkSSID: deviceInfo.ssid,
      deviceIPAddress: deviceInfo.ipAddr,
      minimumPowerOutput_W: deviceState.minPower,
      maximumPowerOutput_W: deviceState.maxPower,
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

async function publishEnergyTopic(deviceState: DeviceState, outputData: OutputData | null): Promise<void> {
  if (outputData) {
    const payload = {
      observedAt: Math.floor(Date.now() / 1000),
      channel1EnergyLifetime_kWh: outputData.te1,
      channel2EnergyLifetime_kWh: outputData.te2,
      totalEnergyLifetime_kWh: outputData.te1 + outputData.te2,
    };
    mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/energy`, payload, true);
    logger.debug(`Published energy topic for ${deviceState.mqttTopic}`, { payload });
  }
}

/** Published (not retained) on `<base>/<device>/status`; nulls mean "asked and got nothing". */
interface StatusPayload {
  observedAt: number;
  isOnline: boolean;
  deviceLastSeenAt: number | null;
  sunAzimuth_deg?: number;
  sunElevation_deg?: number;
  isSunUp?: boolean;
  sunriseAt?: SunState['sunriseAt'];
  sunsetAt?: SunState['sunsetAt'];
  isPollSkipped?: boolean;
  channel1Power_W: number | null;
  channel1EnergySinceStartup_kWh: number | null;
  channel2Power_W: number | null;
  channel2EnergySinceStartup_kWh: number | null;
  totalPower_W: number | null;
  totalEnergySinceStartup_kWh: number | null;
  isOffGrid: boolean | null;
  isOutputFault: boolean | null;
  isChannel1ShortCircuit: boolean | null;
  isChannel2ShortCircuit: boolean | null;
}

async function fetchAndPublishStatus(deviceState: DeviceState, sun: SunState | null): Promise<OutputData | null> {
  // The EZ1 is powered from its own PV input, so after dark it is off, not idle — polling
  // it then just buys two timeouts and a nightly false "outage".
  const asleep = sun !== null && !sun.isSunUp;

  let outputData: OutputData | null = null;
  let alarmInfo: AlarmInfo | null = null;
  if (!asleep) {
    const api = new EZ1API(deviceState.ip);
    outputData = await api.getOutputData();
    alarmInfo = await api.getAlarm();
  }

  const wasOnline = deviceState.isOnline;
  deviceState.isOnline = !!outputData;

  const seenAt = Math.floor(Date.now() / 1000);
  if (deviceState.isOnline) {
    deviceState.lastSeenAt = seenAt;
  }

  // Recorded here, where online-ness is actually decided, so the metric cannot drift from the state
  // the rest of the app acts on. A poll skipped for darkness is neither a success nor an error — it
  // was never attempted, and counting it either way would corrupt both signals.
  if (!asleep) {
    if (deviceState.isOnline) {
      recordPollSuccess(seenAt);
    } else {
      recordPollError();
    }
  }
  recordDeviceOnline(deviceState.nickname || deviceState.ip, deviceState.isOnline);

  // Without a nickname the topic is the device ID, which only getDeviceInfo can tell us. Learn it
  // before publishing anything: availability is retained and only resent on an online-ness edge,
  // so one written to `<base>//availability` leaves Home Assistant showing the device unavailable
  // until the next sunrise. Retried every poll until it succeeds.
  const hadTopic = !!deviceState.mqttTopic;
  if (deviceState.isOnline && (!wasOnline || !hadTopic)) {
    await fetchAndPublishInfo(deviceState);
  }
  if (!deviceState.mqttTopic) {
    logger.debug(`Device ${deviceState.ip} has no topic yet (no nickname, device ID unknown) — not publishing.`);
    return outputData;
  }

  if (deviceState.isOnline !== wasOnline || !hadTopic) {
    mqttClient.publishRaw(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`, deviceState.isOnline ? '1' : '0', true);
  }

  const payload: StatusPayload = {
    observedAt: Math.floor(Date.now() / 1000),
    isOnline: deviceState.isOnline,
    deviceLastSeenAt: deviceState.lastSeenAt,
    channel1Power_W: null,
    channel1EnergySinceStartup_kWh: null,
    channel2Power_W: null,
    channel2EnergySinceStartup_kWh: null,
    totalPower_W: null,
    totalEnergySinceStartup_kWh: null,
    isOffGrid: null,
    isOutputFault: null,
    isChannel1ShortCircuit: null,
    isChannel2ShortCircuit: null,
  };

  if (sun) {
    payload.sunAzimuth_deg = sun.sunAzimuth_deg;
    payload.sunElevation_deg = sun.sunElevation_deg;
    payload.isSunUp = sun.isSunUp;
    payload.sunriseAt = sun.sunriseAt;
    payload.sunsetAt = sun.sunsetAt;
    // Distinguishes "asked and got nothing" from "didn't ask".
    payload.isPollSkipped = asleep;
  }

  if (outputData) {
    payload.channel1Power_W = outputData.p1;
    payload.channel1EnergySinceStartup_kWh = outputData.e1;
    payload.channel2Power_W = outputData.p2;
    payload.channel2EnergySinceStartup_kWh = outputData.e2;
    payload.totalPower_W = outputData.p1 + outputData.p2;
    payload.totalEnergySinceStartup_kWh = outputData.e1 + outputData.e2;
  }

  if (alarmInfo) {
    payload.isOffGrid = alarmInfo.og === '1';
    payload.isOutputFault = alarmInfo.oe === '1';
    payload.isChannel1ShortCircuit = alarmInfo.isce1 === '1';
    payload.isChannel2ShortCircuit = alarmInfo.isce2 === '1';
  }

  mqttClient.publish(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/status`, payload);
  return outputData;
}

async function pollDevice(deviceState: DeviceState, sun: SunState | null = currentSun()): Promise<void> {
  if (sun && !sun.isSunUp) {
    logger.debug(
      `Sun is down (elevation ${sun.sunElevation_deg}° <= ${config.sunElevationThreshold}°) — skipping poll of ${deviceState.ip}`,
    );
  } else {
    logger.debug(`Polling device: ${deviceState.ip}`);
  }

  const wasOnline = deviceState.isOnline;
  const outputData = await fetchAndPublishStatus(deviceState, sun);

  if (deviceState.isOnline && deviceState.mqttTopic) {
    await publishEnergyTopic(deviceState, outputData);
    await fetchAndPublishMaxPower(deviceState);
    if (config.homeAssistantEnable && !deviceState.discoveryPublished) {
      publishDiscoveryMessages(deviceState, mqttClient);
      deviceState.discoveryPublished = true;
    }
  }

  if (deviceState.isOnline && !wasOnline) {
    // Info was already fetched by fetchAndPublishStatus, before anything was published.
    logger.info(`Device ${deviceState.ip} is now online.`);
  } else if (!deviceState.isOnline && wasOnline) {
    // Going offline at dusk is expected; warning nightly trains you to ignore the warning.
    if (sun && !sun.isSunUp) {
      logger.info(`Device ${deviceState.ip} is asleep for the night (sun below horizon).`);
    } else {
      logger.warn(`Device ${deviceState.ip} went offline.`);
    }
  }
}

/** The fields restoreState reads back from a retained `info` message (see fetchAndPublishInfo). */
interface RetainedInfo {
  deviceIdentifier: string;
  deviceIPAddress?: string;
  minimumPowerOutput_W?: number;
  maximumPowerOutput_W?: number;
}

/** Retained messages are whatever is on the broker — possibly hand-written or from an older
 * version — so check the shape instead of trusting it. Null if it isn't usable. */
function parseRetainedInfo(messageString: string): RetainedInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageString);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.deviceIdentifier !== 'string' || !p.deviceIdentifier) return null;
  return {
    deviceIdentifier: p.deviceIdentifier,
    deviceIPAddress: typeof p.deviceIPAddress === 'string' ? p.deviceIPAddress : undefined,
    minimumPowerOutput_W: typeof p.minimumPowerOutput_W === 'number' ? p.minimumPowerOutput_W : undefined,
    maximumPowerOutput_W: typeof p.maximumPowerOutput_W === 'number' ? p.maximumPowerOutput_W : undefined,
  };
}

async function restoreState(): Promise<void> {
  return new Promise((resolve) => {
    const wildcardTopic = `${config.mqttBaseTopic}/#`;
    mqttClient.subscribe(wildcardTopic);

    const restoreMessageHandler = (topic: string, message: Buffer) => {
      const messageString = message.toString();
      logger.debug(`Restoring state from topic: ${topic}`, { payload: messageString });

      const infoTopicRegex = new RegExp(`^${config.mqttBaseTopic}/(.+)/info$`);
      const match = topic.match(infoTopicRegex);

      if (match) {
        const deviceTopic = match[1];
        const payload = parseRetainedInfo(messageString);
        if (!payload) {
          logger.warn(`Ignoring unusable retained info on ${topic}`);
          return;
        }
        // A nickname-less device's topic is its device ID, which is exactly what we're trying to
        // restore — so until it's known, the only link to its retained info is the IP it reported.
        const deviceState = deviceStates.find(d =>
          d.mqttTopic === deviceTopic ||
          d.nickname === deviceTopic ||
          (!d.mqttTopic && payload.deviceIPAddress === d.ip));
        if (deviceState) {
          deviceState.deviceId = payload.deviceIdentifier;
          deviceState.minPower = payload.minimumPowerOutput_W;
          deviceState.maxPower = payload.maximumPowerOutput_W;
          if (!deviceState.nickname) {
            deviceState.mqttTopic = payload.deviceIdentifier;
          }
        }
      }
    };

    mqttClient.on('message', restoreMessageHandler);

    const restoreTimeout = setTimeout(() => {
      logger.info('State restoration complete.');
      mqttClient.removeListener('message', restoreMessageHandler);
      mqttClient.unsubscribe(wildcardTopic);
      resolve();
    }, 2000); // Wait 2 seconds for all retained messages
  });
}

// Runs once per successful (re)connect — not just the first one. A publish attempted while
// disconnected is dropped, not queued, so any retained topic (info, maxPower, discovery,
// availability) for a device that came online during an outage needs a deliberate resend once
// the broker is reachable again, rather than waiting for the device's next offline→online edge.
async function onMqttConnected(): Promise<void> {
  await restoreState();

  for (const deviceState of deviceStates) {
    if (deviceState.isOnline) {
      await fetchAndPublishInfo(deviceState);
    }
    // Still unknown: fetchAndPublishInfo subscribes once a later poll learns it.
    if (!deviceState.mqttTopic) continue;

    if (config.homeAssistantEnable) {
      mqttClient.subscribe(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/maxPower_W/set`);
    }

    if (deviceState.isOnline) {
      mqttClient.publishRaw(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`, '1', true);
      await fetchAndPublishMaxPower(deviceState);
    }

    // Online or not: an inverter asleep at startup still has an identity restored from its retained
    // info, and Home Assistant should know about it before sunrise rather than only after.
    if (config.homeAssistantEnable && deviceState.deviceId) {
      publishDiscoveryMessages(deviceState, mqttClient);
      deviceState.discoveryPublished = true;
    }
  }
}

async function main(): Promise<void> {
  // BEFORE the MQTT connect, deliberately: `connect()` resolves only once the broker answers, so
  // starting the endpoint afterwards would mean the one situation `mqtt_connected` exists to report
  // — the broker being unreachable — is also the situation where nothing is listening to report it.
  metricsServer = startMetricsServer({
    mqttConnected: () => mqttClient.connected,
    pollingExpected: () => {
      const sun = currentSun();
      return sun === null || sun.isSunUp;
    },
    sunElevationDeg: () => currentSun()?.sunElevation_deg ?? null,
    mqttDisconnectedForMs: () => mqttClient.disconnectedForMs(),
  });

  mqttClient.on('message', (topic, message) => {
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
          }).catch((error: unknown) => {
            logger.error(`Failed to set max power for ${deviceTopic}: ${errorMessage(error)}`);
          });
        } else {
          logger.warn(`Invalid power value received for ${deviceTopic}: ${messageString}`);
        }
      } else {
        logger.warn(`Received setMaxPower command for unknown device: ${deviceTopic}`);
      }
    }
  });

  // Fires on the first connect AND every reconnect (mqtt.js re-emits 'connect' each time).
  mqttClient.on('connect', () => {
    onMqttConnected().catch((error: unknown) => logger.error('onMqttConnected failed', { error: errorMessage(error) }));
  });

  // Not awaited: mqtt.js retries internally (see mqtt.ts), and the inverter poll loop below must
  // never wait on the broker. A stuck first connect attempt used to block everything after it,
  // including polling, leaving the process silently idle for as long as the broker was unreachable.
  void mqttClient.connect();

  // Initial poll for all devices, independent of MQTT connectivity.
  for (const deviceState of deviceStates) {
    await pollDevice(deviceState);
  }

  // Set up polling interval
  setInterval(async () => {
    const sun = currentSun();
    for (const deviceState of deviceStates) {
      await pollDevice(deviceState, sun);
    }
  }, config.pollInterval * 1000);
}

function shutdown() {
  logger.info('Shutting down...');
  metricsServer?.close();
  for (const deviceState of deviceStates) {
    if (deviceState.isOnline && deviceState.mqttTopic) {
      mqttClient.publishRaw(`${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`, '0', true);
    }
  }
  mqttClient.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error: unknown) => {
  logger.error('Application crashed:', { error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
