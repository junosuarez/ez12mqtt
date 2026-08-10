import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

// config.ts reads env at import time and exits on invalid input, so the environment has to be set
// up before the module graph is loaded. A device is required for config validation to pass.
process.env.DEVICE_1_IP ??= '10.0.0.1';
process.env.DEVICE_1_NICKNAME ??= 'test-inverter';

const { counters, deviceOnline, metricsText, recordDeviceOnline, recordPollError, recordPollSuccess } =
  await import('../src/metrics.ts');

function parse(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.lastIndexOf(' ');
    out.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return out;
}

const sources = (over: Partial<Parameters<typeof metricsText>[0]> = {}) => ({
  mqttConnected: () => true,
  pollingExpected: () => true,
  sunElevationDeg: () => 12.5,
  ...over,
});

describe('metrics exposition', () => {
  it('reports mqtt_connected unprefixed, matching cave\'s cross-service convention', () => {
    assert.equal(parse(metricsText(sources())).get('mqtt_connected'), '1');
    assert.equal(parse(metricsText(sources({ mqttConnected: () => false }))).get('mqtt_connected'), '0');
  });

  it('reads connection state at scrape time rather than from a remembered event', () => {
    let connected = false;
    const s = sources({ mqttConnected: () => connected });
    assert.equal(parse(metricsText(s)).get('mqtt_connected'), '0');
    connected = true;
    assert.equal(parse(metricsText(s)).get('mqtt_connected'), '1');
  });

  it('exposes polling_expected so staleness can be alerted on only while the sun is up', () => {
    assert.equal(parse(metricsText(sources())).get('ez12mqtt_polling_expected'), '1');
    assert.equal(
      parse(metricsText(sources({ pollingExpected: () => false }))).get('ez12mqtt_polling_expected'),
      '0',
    );
  });

  it('advances the success timestamp only for polls that reached the inverter', () => {
    recordPollSuccess(1000);
    assert.equal(
      parse(metricsText(sources())).get('ez12mqtt_poll_last_success_timestamp_seconds'),
      '1000',
    );
    const pollsBefore = counters.polls;
    recordPollError();
    // The failure counts as an attempt but must NOT move the freshness timestamp — that is the whole
    // point of the signal: a wedged inverter with a healthy process has to look stale.
    assert.equal(counters.polls, pollsBefore + 1);
    assert.equal(
      parse(metricsText(sources())).get('ez12mqtt_poll_last_success_timestamp_seconds'),
      '1000',
    );
    recordPollSuccess(2000);
    assert.equal(
      parse(metricsText(sources())).get('ez12mqtt_poll_last_success_timestamp_seconds'),
      '2000',
    );
  });

  it('counts errors separately from total attempts', () => {
    const polls = counters.polls;
    const errors = counters.pollErrors;
    recordPollError();
    recordPollSuccess(3000);
    const m = parse(metricsText(sources()));
    assert.equal(m.get('ez12mqtt_polls_total'), String(polls + 2));
    assert.equal(m.get('ez12mqtt_poll_errors_total'), String(errors + 1));
  });

  it('labels per-device reachability and escapes the label value', () => {
    deviceOnline.clear();
    recordDeviceOnline('roof "north"', true);
    recordDeviceOnline('shed', false);
    const m = parse(metricsText(sources()));
    assert.equal(m.get('ez12mqtt_device_online{device="roof \\"north\\""}'), '1');
    assert.equal(m.get('ez12mqtt_device_online{device="shed"}'), '0');
  });

  it('omits sun elevation entirely when no location is configured', () => {
    const text = metricsText(sources({ sunElevationDeg: () => null }));
    assert.ok(!text.includes('ez12mqtt_sun_elevation_degrees'));
    // Absent, not zero: 0 degrees is a real elevation (sunrise), so emitting it as a placeholder
    // would read as "the sun is exactly on the horizon" forever.
    assert.ok(metricsText(sources()).includes('ez12mqtt_sun_elevation_degrees 12.5'));
  });

  it('emits a HELP and TYPE line for every metric it exposes', () => {
    const text = metricsText(sources());
    const names = new Set([...parse(text).keys()].map((k) => k.split('{')[0]));
    for (const name of names) {
      assert.ok(text.includes(`# HELP ${name} `), `${name} is missing a HELP line`);
      assert.ok(text.includes(`# TYPE ${name} `), `${name} is missing a TYPE line`);
    }
  });
});

describe('metrics endpoint is opt-in', () => {
  let started: Awaited<ReturnType<typeof startServerWith>>;

  async function startServerWith(port: string | undefined) {
    // config is a module singleton, so a fresh port needs a fresh module registry. Node's test
    // runner has no module-cache reset, so this is exercised via a subprocess instead.
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env, DEVICE_1_IP: '10.0.0.1' } as Record<string, string>;
    if (port === undefined) delete env.METRICS_PORT;
    else env.METRICS_PORT = port;
    const script = `
      const m = await import('./src/metrics.ts');
      const server = m.startMetricsServer({
        mqttConnected: () => false, pollingExpected: () => true, sunElevationDeg: () => null,
      });
      console.log(JSON.stringify({ listening: server !== null }));
      server?.close();
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname,
    });
    return JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!);
  }

  it('creates no listener when METRICS_PORT is unset — the outbound-only default', async () => {
    assert.equal((await startServerWith(undefined)).listening, false);
  });

  it('creates a listener when METRICS_PORT is set', async () => {
    assert.equal((await startServerWith('19100')).listening, true);
  });

  it('treats a blank METRICS_PORT as unset rather than as a parse error', async () => {
    assert.equal((await startServerWith('   ')).listening, false);
  });
});
