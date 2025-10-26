import { logger, setLogLevel } from './logger.ts';

interface DeviceConfig {
  ip: string;
  nickname?: string;
  description?: string;
}

interface Config {
  devices: DeviceConfig[];
  mqttHost: string;
  mqttPort: number;
  mqttUser?: string;
  mqttPassword?: string;
  mqttBaseTopic: string;
  pollInterval: number;
  logLevel: 'INFO' | 'DEBUG';
}

function validateConfig(config: Partial<Config>): Config {
  const errors: string[] = [];

  if (!config.devices || config.devices.length === 0) {
    errors.push('At least one device must be configured using DEVICE_n_IP.');
  }

  if (!config.mqttHost) {
    errors.push('MQTT_HOST is required.');
  }

  if (!config.mqttPort || isNaN(config.mqttPort)) {
    errors.push('MQTT_PORT is required and must be a number.');
  }

  if (!config.mqttBaseTopic) {
    errors.push('MQTT_BASE_TOPIC is required.');
  }

  if (!config.pollInterval || isNaN(config.pollInterval) || config.pollInterval <= 0) {
    errors.push('POLL_INTERVAL is required and must be a positive number.');
  }

  if (errors.length > 0) {
    errors.forEach(error => logger.error(error));
    process.exit(1);
  }

  return config as Config;
}

function parseDevices(): DeviceConfig[] {
  const devices: DeviceConfig[] = [];
  let i = 1;
  while (process.env[`DEVICE_${i}_IP`]) {
    const ip = process.env[`DEVICE_${i}_IP`] as string;
    const nickname = process.env[`DEVICE_${i}_NICKNAME`];
    const description = process.env[`DEVICE_${i}_DESCRIPTION`];

    if (!ip) {
      logger.error(`DEVICE_${i}_IP is defined but empty. Skipping device ${i}.`);
      i++;
      continue;
    }

    devices.push({
      ip,
      ...(nickname && { nickname }),
      ...(description && { description }),
    });
    i++;
  }
  return devices;
}

const rawLogLevel = process.env.LOG_LEVEL?.toUpperCase();
const logLevel: 'INFO' | 'DEBUG' = (rawLogLevel === 'DEBUG' ? 'DEBUG' : 'INFO');
setLogLevel(logLevel);

const config: Config = validateConfig({
  devices: parseDevices(),
  mqttHost: process.env.MQTT_HOST || 'localhost',
  mqttPort: parseInt(process.env.MQTT_PORT || '1883', 10),
  mqttUser: process.env.MQTT_USER,
  mqttPassword: process.env.MQTT_PASSWORD,
  mqttBaseTopic: process.env.MQTT_BASE_TOPIC || 'ez12mqtt',
  pollInterval: parseInt(process.env.POLL_INTERVAL || '30', 10),
  logLevel: logLevel,
});

export default config;
