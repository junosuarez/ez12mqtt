import { readFileSync } from 'node:fs';
import { logger, setLogLevel } from './logger.ts';

interface DeviceConfig {
  ip: string;
  nickname?: string;
  description?: string;
}

/** Contents, not paths: the files are read at startup so a bad path fails there, not at connect. */
export interface MqttTls {
  /** PEM CA bundle for a broker with a private CA; absent means the system's trusted CAs. */
  ca?: string;
  /** PEM client certificate and key, for brokers that require mutual TLS. Both or neither. */
  cert?: string;
  key?: string;
}

interface Config {
  devices: DeviceConfig[];
  mqttHost: string;
  mqttPort: number;
  /** Set when MQTT_TLS=true; absent means plain mqtt://, the default. */
  mqttTls?: MqttTls;
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

type Env = Record<string, string | undefined>;

export interface ParsedConfig {
  config: Config;
  /** Fatal: the process logs these and exits rather than run on a config it misread. */
  errors: string[];
  warnings: string[];
}

// ---- strict scalar parsing ---------------------------------------------------------------------
// parseInt/parseFloat read a prefix and ignore the rest, so `POLL_INTERVAL=30s` used to mean 30 and
// `SUN_ELEVATION_THRESHOLD=abc` meant NaN — which compared false against every elevation and so
// silently skipped every poll, day and night. Every number is now all-or-nothing.

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Unset or blank → the default; anything else must be a whole number in range, or it's an error. */
function integer(env: Env, name: string, fallback: number | undefined, min: number, max: number, errors: string[]): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!INTEGER.test(raw) || n < min || n > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}; got "${raw}".`);
    return fallback;
  }
  return n;
}

function decimal(env: Env, name: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!DECIMAL.test(raw) || n < min || n > max) {
    errors.push(`${name} must be a number from ${min} to ${max}; got "${raw}".`);
    return fallback;
  }
  return n;
}

/** `true`/`false` in any case; unset is false. `HOMEASSISTANT_ENABLE=1` used to silently mean off. */
function boolean(env: Env, name: string, errors: string[]): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  errors.push(`${name} must be "true" or "false"; got "${env[name]}".`);
  return false;
}

// ---- topics -----------------------------------------------------------------------------------

/**
 * A topic (or prefix) we publish under and subscribe beneath. MQTT reserves `+` and `#` as
 * wildcards and `$` as a leading character, and an empty level (`a//b`) is almost always a typo —
 * any of these would leave subscriptions silently matching nothing, or the wrong things.
 */
function topicError(name: string, value: string): string | null {
  if (/[+#\u0000]/.test(value)) return `${name} must not contain "+", "#" or NUL; got "${value}".`;
  if (value.startsWith('$')) return `${name} must not start with "$" (reserved for broker topics); got "${value}".`;
  if (value.split('/').some((level) => level === '')) return `${name} must not start or end with "/" or contain "//"; got "${value}".`;
  return null;
}

// ---- sections ---------------------------------------------------------------------------------

/** Hostname or IPv4 only: EZ1API builds `http://<ip>:8050`, so a scheme, port or path here breaks it. */
const HOST = /^[A-Za-z0-9.-]+$/;

function parseDevices(env: Env, errors: string[]): DeviceConfig[] {
  const devices: DeviceConfig[] = [];
  for (let i = 1; env[`DEVICE_${i}_IP`]?.trim(); i++) {
    const ip = env[`DEVICE_${i}_IP`]!.trim();
    const nickname = env[`DEVICE_${i}_NICKNAME`]?.trim() || undefined;
    const description = env[`DEVICE_${i}_DESCRIPTION`];
    if (!HOST.test(ip)) errors.push(`DEVICE_${i}_IP must be a hostname or IPv4 address, without scheme or port; got "${ip}".`);
    // A nickname is a single topic level: `<base>/<nickname>/status`.
    if (nickname) {
      const problem = nickname.includes('/') ? `DEVICE_${i}_NICKNAME must not contain "/"; got "${nickname}".` : topicError(`DEVICE_${i}_NICKNAME`, nickname);
      if (problem) errors.push(problem);
    }
    devices.push({ ip, ...(nickname && { nickname }), ...(description && { description }) });
  }

  // Numbering stops at the first gap, so a DEVICE_3_* with no DEVICE_2_IP used to be silently ignored.
  const configured = new Set(devices.map((_, i) => String(i + 1)));
  const stray = Object.keys(env)
    .map((key) => /^DEVICE_(\d+)_(IP|NICKNAME|DESCRIPTION)$/.exec(key))
    .filter((m): m is RegExpExecArray => m !== null && !configured.has(m[1]) && !!env[m[0]]?.trim())
    .map((m) => m[0])
    .sort();
  if (stray.length > 0) {
    errors.push(`${stray.join(', ')} would be ignored: devices are numbered DEVICE_1_IP, DEVICE_2_IP, … with no gaps, and each needs an IP.`);
  }

  const seen = (values: (string | undefined)[], what: string) => {
    const dupes = values.filter((v, i) => v !== undefined && values.indexOf(v) !== i);
    if (dupes.length > 0) errors.push(`Two devices share ${what} "${dupes[0]}"; each must be unique.`);
  };
  seen(devices.map((d) => d.ip), 'the IP');
  seen(devices.map((d) => d.nickname), 'the nickname');

  if (devices.length === 0) errors.push('At least one device must be configured using DEVICE_n_IP.');
  return devices;
}

/** Both or neither: a half-set location would silently compute the wrong solar position. Invalid
 * values disable the sun features with a warning rather than failing, as before. */
function parseLocation(env: Env, warnings: string[]): { latitude?: number; longitude?: number } {
  const rawLat = env.LATITUDE?.trim();
  const rawLon = env.LONGITUDE?.trim();
  if (!rawLat && !rawLon) return {};

  if (!rawLat || !rawLon) {
    warnings.push('Only one of LATITUDE/LONGITUDE is set — both are required. Sun features disabled.');
    return {};
  }

  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!DECIMAL.test(rawLat) || latitude < -90 || latitude > 90) {
    warnings.push(`LATITUDE ${rawLat} is not a number in [-90, 90]. Sun features disabled.`);
    return {};
  }
  if (!DECIMAL.test(rawLon) || longitude < -180 || longitude > 180) {
    warnings.push(`LONGITUDE ${rawLon} is not a number in [-180, 180]. Sun features disabled.`);
    return {};
  }
  return { latitude, longitude };
}

function parseSunNowOverride(env: Env, errors: string[], warnings: string[]): Date | undefined {
  const raw = env.SUN_NOW_OVERRIDE?.trim();
  if (!raw) return undefined;

  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    errors.push(`SUN_NOW_OVERRIDE must be a date; got "${raw}".`);
    return undefined;
  }
  // Loud on purpose: this freezes the sun and must never go unnoticed outside a test.
  warnings.push(`SUN_NOW_OVERRIDE is set — solar position is pinned to ${date.toISOString()}. Test use only.`);
  return date;
}

function parseLogLevel(env: Env, errors: string[]): 'INFO' | 'DEBUG' {
  const raw = env.LOG_LEVEL?.trim().toUpperCase();
  if (!raw || raw === 'INFO') return 'INFO';
  if (raw === 'DEBUG') return 'DEBUG';
  errors.push(`LOG_LEVEL must be INFO or DEBUG; got "${env.LOG_LEVEL}".`);
  return 'INFO';
}

// ---- TLS ---------------------------------------------------------------------------------------

const TLS_FILES = [['MQTT_CA_FILE', 'ca'], ['MQTT_CERT_FILE', 'cert'], ['MQTT_KEY_FILE', 'key']] as const;

export type ReadFile = (path: string) => string;
const readUtf8: ReadFile = (path) => readFileSync(path, 'utf8');

/** Undefined unless MQTT_TLS=true. Certificate verification is never switched off: a broker with a
 * private CA is what MQTT_CA_FILE is for. */
function parseTls(env: Env, readFile: ReadFile, errors: string[]): MqttTls | undefined {
  const enabled = boolean(env, 'MQTT_TLS', errors);
  const paths = TLS_FILES.filter(([name]) => env[name]?.trim());
  if (!enabled) {
    // Set but inert would mean credentials quietly going over plain TCP.
    if (paths.length > 0) errors.push(`${paths.map(([name]) => name).join(', ')} only apply with MQTT_TLS=true.`);
    return undefined;
  }
  if (!!env.MQTT_CERT_FILE?.trim() !== !!env.MQTT_KEY_FILE?.trim()) {
    errors.push('MQTT_CERT_FILE and MQTT_KEY_FILE must be set together (client certificate and its key).');
  }
  const tls: MqttTls = {};
  for (const [name, field] of paths) {
    const path = env[name]!.trim();
    try {
      tls[field] = readFile(path);
    } catch (error: unknown) {
      const reason = error instanceof Error && 'code' in error ? String(error.code) : String(error);
      errors.push(`${name} could not be read from "${path}" (${reason}).`);
    }
  }
  return tls;
}

/** Pure apart from `readFile` (injectable for tests): never exits or logs, so every rule here is
 * unit-testable. */
export function parseConfig(env: Env, readFile: ReadFile = readUtf8): ParsedConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mqttTls = parseTls(env, readFile, errors);

  const mqttBaseTopic = env.MQTT_BASE_TOPIC?.trim() || 'ez12mqtt';
  const homeAssistantDiscoveryPrefix = env.HOMEASSISTANT_DISCOVERY_PREFIX?.trim() || 'homeassistant';
  for (const [name, value] of [['MQTT_BASE_TOPIC', mqttBaseTopic], ['HOMEASSISTANT_DISCOVERY_PREFIX', homeAssistantDiscoveryPrefix]]) {
    const problem = topicError(name, value);
    if (problem) errors.push(problem);
  }

  const config: Config = {
    devices: parseDevices(env, errors),
    mqttHost: env.MQTT_HOST?.trim() || 'localhost',
    // 8883 is MQTT-over-TLS's registered port, as 1883 is plain MQTT's.
    mqttPort: integer(env, 'MQTT_PORT', mqttTls ? 8883 : 1883, 1, 65535, errors)!,
    ...(mqttTls && { mqttTls }),
    mqttUser: env.MQTT_USER,
    mqttPassword: env.MQTT_PASSWORD,
    mqttBaseTopic,
    pollInterval: integer(env, 'POLL_INTERVAL', 30, 1, 86400, errors)!,
    logLevel: parseLogLevel(env, errors),
    homeAssistantEnable: boolean(env, 'HOMEASSISTANT_ENABLE', errors),
    homeAssistantDiscoveryPrefix,
    ...parseLocation(env, warnings),
    sunElevationThreshold: decimal(env, 'SUN_ELEVATION_THRESHOLD', -6, -90, 90, errors),
    sunNowOverride: parseSunNowOverride(env, errors, warnings),
    // Unset or blank is the documented "off"; a set-but-bad port fails rather than silently leave
    // metrics disabled and be discovered months later.
    metricsPort: integer(env, 'METRICS_PORT', undefined, 1, 65535, errors),
  };

  return { config, errors, warnings };
}

const { config, errors, warnings } = parseConfig(process.env);
setLogLevel(config.logLevel);
warnings.forEach((warning) => logger.warn(warning));
if (errors.length > 0) {
  errors.forEach((error) => logger.error(error));
  process.exit(1);
}

export default config;
