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
  homeAssistantEnable: boolean;
  homeAssistantDiscoveryPrefix: string;
  /** Both required to enable the sun features; unset means poll around the clock. */
  latitude?: number;
  longitude?: number;
  /**
   * Elevation (deg) at or below which polling is skipped. Defaults to -6 (civil twilight)
   * not 0: skipping a poll while it's still producing loses data, polling a sleeping
   * inverter costs one timeout — so it errs toward polling.
   */
  sunElevationThreshold: number;
  /** Test-only: pins "now" for solar position so e2e can assert on a fixed day or night. */
  sunNowOverride?: Date;
  /**
   * Port for the Prometheus /metrics endpoint. UNSET MEANS OFF — no listener is created and the
   * app keeps its outbound-only posture. There is deliberately no default: opening an inbound port
   * should be something you asked for.
   */
  metricsPort?: number;
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

  // Only validated when present: absent is the documented "off" state, but a typo'd port should
  // fail at startup rather than silently leave metrics disabled and be discovered months later.
  if (config.metricsPort !== undefined) {
    if (isNaN(config.metricsPort) || config.metricsPort < 1 || config.metricsPort > 65535) {
      errors.push('METRICS_PORT must be a port number between 1 and 65535 when set.');
    }
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

/** Both or neither: a half-set location would silently compute the wrong solar position. */
function parseLocation(): { latitude?: number; longitude?: number } {
  const rawLat = process.env.LATITUDE;
  const rawLon = process.env.LONGITUDE;
  if (!rawLat && !rawLon) return {};

  if (!rawLat || !rawLon) {
    logger.warn('Only one of LATITUDE/LONGITUDE is set — both are required. Sun features disabled.');
    return {};
  }

  const latitude = parseFloat(rawLat);
  const longitude = parseFloat(rawLon);
  if (isNaN(latitude) || latitude < -90 || latitude > 90) {
    logger.warn(`LATITUDE ${rawLat} is not a number in [-90, 90]. Sun features disabled.`);
    return {};
  }
  if (isNaN(longitude) || longitude < -180 || longitude > 180) {
    logger.warn(`LONGITUDE ${rawLon} is not a number in [-180, 180]. Sun features disabled.`);
    return {};
  }
  return { latitude, longitude };
}

function parseSunNowOverride(): Date | undefined {
  const raw = process.env.SUN_NOW_OVERRIDE;
  if (!raw) return undefined;

  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    logger.error(`SUN_NOW_OVERRIDE ${raw} is not a valid date. Ignoring.`);
    return undefined;
  }
  // Loud on purpose: this freezes the sun and must never go unnoticed outside a test.
  logger.warn(`SUN_NOW_OVERRIDE is set — solar position is pinned to ${date.toISOString()}. Test use only.`);
  return date;
}

/** Undefined (not a default port) when unset or blank — that is how the endpoint stays off. */
function parseMetricsPort(): number | undefined {
  const raw = process.env.METRICS_PORT?.trim();
  if (!raw) return undefined;
  return parseInt(raw, 10);
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
  homeAssistantEnable: process.env.HOMEASSISTANT_ENABLE === 'true',
  homeAssistantDiscoveryPrefix: process.env.HOMEASSISTANT_DISCOVERY_PREFIX || 'homeassistant',
  ...parseLocation(),
  sunElevationThreshold: parseFloat(process.env.SUN_ELEVATION_THRESHOLD || '-6'),
  sunNowOverride: parseSunNowOverride(),
  metricsPort: parseMetricsPort(),
});

export default config;
