import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// Importing config.ts also evaluates process.env (and exits on errors), so give it a valid device.
process.env.DEVICE_1_IP ??= '10.0.0.1';
const { parseConfig } = await import('../src/config.ts');

const base = { DEVICE_1_IP: '10.0.0.1' };
const errorsFor = (env: Record<string, string>) => parseConfig({ ...base, ...env }).errors;

describe('config — numbers are all-or-nothing', () => {
  it('accepts the defaults', () => {
    const { config, errors, warnings } = parseConfig(base);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(config.mqttPort, 8883, 'TLS by default, on its registered port');
    assert.deepEqual(config.mqttTls, {});
    assert.equal(config.pollInterval, 30);
    assert.equal(config.sunElevationThreshold, -6);
    assert.equal(config.metricsPort, undefined);
  });

  it('rejects SUN_ELEVATION_THRESHOLD=abc, which used to silently skip every poll', () => {
    assert.match(errorsFor({ SUN_ELEVATION_THRESHOLD: 'abc' }).join(), /SUN_ELEVATION_THRESHOLD/);
    assert.equal(parseConfig({ ...base, SUN_ELEVATION_THRESHOLD: '-0.833' }).config.sunElevationThreshold, -0.833);
  });

  it('rejects trailing junk that parseInt would have ignored', () => {
    for (const [name, value] of [['POLL_INTERVAL', '30s'], ['MQTT_PORT', '1883abc'], ['METRICS_PORT', '9100x']]) {
      assert.match(errorsFor({ [name]: value }).join(), new RegExp(name), `${name}=${value}`);
    }
  });

  it('rejects out-of-range ports and intervals', () => {
    for (const [name, value] of [['MQTT_PORT', '0'], ['MQTT_PORT', '70000'], ['POLL_INTERVAL', '0'], ['POLL_INTERVAL', '1.5'], ['METRICS_PORT', '-1']]) {
      assert.match(errorsFor({ [name]: value }).join(), new RegExp(name), `${name}=${value}`);
    }
  });

  it('treats a blank METRICS_PORT as unset, not an error', () => {
    const { config, errors } = parseConfig({ ...base, METRICS_PORT: '   ' });
    assert.deepEqual(errors, []);
    assert.equal(config.metricsPort, undefined);
  });

  it('disables (with a warning) rather than misreads a bad location', () => {
    const { config, warnings, errors } = parseConfig({ ...base, LATITUDE: '12abc', LONGITUDE: '5' });
    assert.deepEqual(errors, []);
    assert.equal(config.latitude, undefined);
    assert.match(warnings.join(), /LATITUDE/);
  });
});

describe('config — enumerations', () => {
  it('accepts true/false in any case and rejects anything else for HOMEASSISTANT_ENABLE', () => {
    assert.equal(parseConfig({ ...base, HOMEASSISTANT_ENABLE: 'TRUE' }).config.homeAssistantEnable, true);
    assert.equal(parseConfig({ ...base, HOMEASSISTANT_ENABLE: 'false' }).config.homeAssistantEnable, false);
    assert.match(errorsFor({ HOMEASSISTANT_ENABLE: '1' }).join(), /HOMEASSISTANT_ENABLE/);
  });

  it('rejects an unknown LOG_LEVEL instead of quietly using INFO', () => {
    assert.equal(parseConfig({ ...base, LOG_LEVEL: 'debug' }).config.logLevel, 'DEBUG');
    assert.match(errorsFor({ LOG_LEVEL: 'verbose' }).join(), /LOG_LEVEL/);
  });
});

describe('config — topics', () => {
  it('rejects wildcards, a leading $, and empty levels in the base topic and discovery prefix', () => {
    for (const value of ['ez/+', 'ez/#', '$ez', '/ez', 'ez/', 'a//b']) {
      assert.match(errorsFor({ MQTT_BASE_TOPIC: value }).join(), /MQTT_BASE_TOPIC/, value);
      assert.match(errorsFor({ HOMEASSISTANT_DISCOVERY_PREFIX: value }).join(), /HOMEASSISTANT_DISCOVERY_PREFIX/, value);
    }
  });

  it('allows a multi-level base topic', () => {
    assert.deepEqual(errorsFor({ MQTT_BASE_TOPIC: 'home/solar' }), []);
  });

  it('requires a nickname to be a single, wildcard-free level', () => {
    for (const value of ['roof/east', 'roof+', 'roof#', '$roof']) {
      assert.match(errorsFor({ DEVICE_1_NICKNAME: value }).join(), /DEVICE_1_NICKNAME/, value);
    }
    assert.deepEqual(errorsFor({ DEVICE_1_NICKNAME: 'roof-east_2' }), []);
  });
});

describe('config — devices', () => {
  it('rejects an IP with a scheme or port, which would build a broken URL', () => {
    for (const value of ['http://10.0.0.1', '10.0.0.1:8050', '10.0.0.1/']) {
      assert.match(errorsFor({ DEVICE_1_IP: value }).join(), /DEVICE_1_IP/, value);
    }
    assert.deepEqual(errorsFor({ DEVICE_1_IP: 'mock-ez1' }), []);
  });

  it('rejects a numbering gap instead of silently ignoring the devices after it', () => {
    assert.match(errorsFor({ DEVICE_3_IP: '10.0.0.3' }).join(), /DEVICE_3_IP/);
    assert.match(errorsFor({ DEVICE_2_NICKNAME: 'orphan' }).join(), /DEVICE_2_NICKNAME/);
  });

  it('rejects duplicate IPs and duplicate nicknames', () => {
    assert.match(errorsFor({ DEVICE_2_IP: '10.0.0.1' }).join(), /share the IP/);
    assert.match(errorsFor({ DEVICE_1_NICKNAME: 'roof', DEVICE_2_IP: '10.0.0.2', DEVICE_2_NICKNAME: 'roof' }).join(), /share the nickname/);
  });

  it('still requires at least one device', () => {
    assert.match(parseConfig({}).errors.join(), /At least one device/);
  });
});

describe('config — MQTT over TLS (#23)', () => {
  const files: Record<string, string> = { '/certs/ca.pem': 'CA', '/certs/client.pem': 'CERT', '/certs/client.key': 'KEY' };
  const readFile = (path: string) => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return files[path];
  };
  const parse = (env: Record<string, string>) => parseConfig({ ...base, ...env }, readFile);

  it('uses verified TLS on 8883 by default', () => {
    const { config, errors, warnings } = parse({});
    assert.deepEqual([errors, warnings], [[], []]);
    assert.deepEqual(config.mqttTls, {});
    assert.equal(config.mqttPort, 8883);
  });

  it('uses plain mqtt on 1883 only with MQTT_INSECURE=true', () => {
    const { config, errors } = parse({ MQTT_INSECURE: 'true' });
    assert.deepEqual(errors, []);
    assert.equal(config.mqttTls, undefined);
    assert.equal(config.mqttPort, 1883);
  });

  it('honours an explicit MQTT_PORT either way', () => {
    assert.equal(parse({ MQTT_PORT: '18883' }).config.mqttPort, 18883);
    assert.equal(parse({ MQTT_INSECURE: 'true', MQTT_PORT: '1884' }).config.mqttPort, 1884);
  });

  it('reads the CA and client certificate at startup', () => {
    const { config, errors } = parse({ MQTT_CA_FILE: '/certs/ca.pem', MQTT_CERT_FILE: '/certs/client.pem', MQTT_KEY_FILE: '/certs/client.key' });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.mqttTls, { ca: 'CA', cert: 'CERT', key: 'KEY' });
  });

  it('fails at startup when a referenced file is missing, naming it', () => {
    assert.match(parse({ MQTT_CA_FILE: '/nope.pem' }).errors.join(), /MQTT_CA_FILE could not be read from "\/nope.pem" \(ENOENT\)/);
  });

  it('requires a client certificate and key together', () => {
    assert.match(parse({ MQTT_CERT_FILE: '/certs/client.pem' }).errors.join(), /MQTT_CERT_FILE and MQTT_KEY_FILE/);
  });

  it('allows skipping verification, with a warning every startup', () => {
    const { config, errors, warnings } = parse({ MQTT_TLS_SKIP_VERIFY: 'true' });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.mqttTls, { skipVerify: true });
    assert.match(warnings.join(), /not verified/);
  });

  it('rejects contradictory settings rather than guess which was meant', () => {
    assert.match(parse({ MQTT_INSECURE: 'true', MQTT_CA_FILE: '/certs/ca.pem' }).errors.join(), /MQTT_INSECURE=true turns TLS off, so MQTT_CA_FILE/);
    assert.match(parse({ MQTT_INSECURE: 'true', MQTT_TLS_SKIP_VERIFY: 'true' }).errors.join(), /MQTT_TLS_SKIP_VERIFY/);
    assert.match(parse({ MQTT_TLS_SKIP_VERIFY: 'true', MQTT_CA_FILE: '/certs/ca.pem' }).errors.join(), /ignores MQTT_CA_FILE/);
  });
});
