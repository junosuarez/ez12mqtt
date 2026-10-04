import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AlarmInfo, DeviceInfo, OutputData } from '../src/api.ts';
import { initialState, reduce, type Effect, type Event, type State } from '../src/bridge.ts';
import type { SunState } from '../src/sun.ts';

// No env, no broker, no HTTP: the reducer is pure, so each test is a list of events in and a list
// of effects out. Most cases below are a bug this codebase actually shipped.

const settings = { baseTopic: 'ez12mqtt', homeAssistant: true };
const IP = '10.0.0.1';
const output: OutputData = { p1: 100, e1: 1, te1: 1000, p2: 50, e2: 2, te2: 2000 };
const alarm: AlarmInfo = { og: '0', oe: '0', isce1: '0', isce2: '0' };
const info: DeviceInfo = { deviceId: 'E28000000238', devVer: 'EZ1 1.0', ssid: 'wifi', ipAddr: IP, minPower: '30', maxPower: '800' };
const day: SunState = { sunAzimuth_deg: 180, sunElevation_deg: 60, isSunUp: true, sunriseAt: 0, sunsetAt: 1 };
const night: SunState = { ...day, sunElevation_deg: -30, isSunUp: false };

/** Runs events in order; returns the final state and every effect, each tagged with its event. */
function run(state: State, events: Event[]) {
  const effects: { after: Event['type']; effect: Effect }[] = [];
  for (const event of events) {
    const result = reduce(state, event);
    state = result.state;
    effects.push(...result.effects.map((effect) => ({ after: event.type, effect })));
  }
  return { state, effects: effects.map((e) => e.effect), tagged: effects };
}

/** Every topic a publishDevice effect would be sent to, as the runner would compose it. */
const publishedTopics = (effects: Effect[]) =>
  effects.flatMap((e) => (e.type === 'publishDevice' ? [`${settings.baseTopic}/${e.address}/${e.subtopic}`] : []));

const online: Event[] = [
  { type: 'tick', now: 1, sun: day },
  { type: 'statusFetched', ip: IP, now: 1, sun: day, output, alarm },
];
const connected: Event[] = [{ type: 'mqttConnected' }, { type: 'restoreWindowClosed' }];

describe('bridge reducer — addressing (#9)', () => {
  it('cannot even express a device publish without an Address (checked by tsc, not at runtime)', () => {
    // @ts-expect-error — a plain string is not an Address; only addressOf() mints one, never from ''.
    const unaddressed: Effect = { type: 'publishDevice', address: '', subtopic: 'availability', payload: '1', retain: true };
    assert.ok(unaddressed);
  });

  it('publishes nothing for a nickname-less device until its device ID is known', () => {
    const { effects } = run(initialState(settings, [{ ip: IP }]), [...connected, ...online]);
    assert.deepEqual(publishedTopics(effects), [], 'no `ez12mqtt//…` topics, or any device topics, before identity');
    assert.ok(effects.some((e) => e.type === 'fetchInfo' && e.ip === IP), 'asks for identity instead');
  });

  it('publishes availability 1 to the device-ID topic as soon as identity arrives', () => {
    const { effects } = run(initialState(settings, [{ ip: IP }]), [
      ...connected, ...online, { type: 'infoFetched', ip: IP, now: 2, info },
    ]);
    const topics = publishedTopics(effects);
    assert.ok(topics.includes('ez12mqtt/E28000000238/availability'));
    assert.ok(topics.every((t) => !t.includes('//')));
  });

  it('restores a nickname-less device from retained info by the IP it reported', () => {
    const retained = JSON.stringify({ deviceIdentifier: 'E28000000238', deviceIPAddress: IP, minimumPowerOutput_W: 30, maximumPowerOutput_W: 800 });
    const { state, effects } = run(initialState(settings, [{ ip: IP }]), [
      { type: 'mqttConnected' },
      { type: 'mqttMessage', topic: 'ez12mqtt/E28000000238/info', payload: retained },
      { type: 'restoreWindowClosed' },
      // Asleep at restart: the inverter never answers, but it still has a topic and HA discovery.
      { type: 'tick', now: 1, sun: night },
    ]);
    assert.equal(state.devices[0].identity?.deviceId, 'E28000000238');
    assert.ok(publishedTopics(effects).includes('ez12mqtt/E28000000238/status'));
    assert.ok(effects.some((e) => e.type === 'announce'), 'offline-at-startup device is announced too (#14)');
  });
});

describe('bridge reducer — subscribe before announce (#14)', () => {
  it('emits the command subscription before any discovery, on every connect', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
      ...online, { type: 'infoFetched', ip: IP, now: 1, info }, ...connected,
    ]);
    const sub = effects.findIndex((e) => e.type === 'subscribe' && e.topic === 'ez12mqtt/inv/maxPower_W/set');
    const announce = effects.findIndex((e) => e.type === 'announce');
    assert.ok(sub !== -1 && announce !== -1);
    assert.ok(sub < announce, 'subscribed before advertising the command topic');
  });

  it('never announces while still restoring, even if identity arrives then', () => {
    const { tagged } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
      { type: 'mqttConnected' }, ...online, { type: 'infoFetched', ip: IP, now: 1, info },
    ]);
    assert.ok(!tagged.some((t) => t.effect.type === 'announce'));
  });

  it('subscribes when a nickname-less device first becomes addressable mid-connection', () => {
    const { effects } = run(initialState(settings, [{ ip: IP }]), [...connected, ...online, { type: 'infoFetched', ip: IP, now: 2, info }]);
    const sub = effects.findIndex((e) => e.type === 'subscribe' && e.topic === 'ez12mqtt/E28000000238/maxPower_W/set');
    const announce = effects.findIndex((e) => e.type === 'announce');
    assert.ok(sub !== -1 && sub < announce);
  });
});

describe('bridge reducer — polling', () => {
  it('never overlaps polls of one device: a tick while a fetch is in flight is a no-op for it', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
      { type: 'tick', now: 1, sun: day },
      { type: 'tick', now: 2, sun: day },
      { type: 'tick', now: 3, sun: day },
    ]);
    assert.equal(effects.filter((e) => e.type === 'fetchStatus').length, 1);
  });

  it('polls again once the previous result has landed', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [...online, { type: 'tick', now: 2, sun: day }]);
    assert.equal(effects.filter((e) => e.type === 'fetchStatus').length, 2);
  });

  it('does not fetch after dark, and does not count it as a poll either way', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [...connected, { type: 'tick', now: 1, sun: night }]);
    assert.ok(!effects.some((e) => e.type === 'fetchStatus' || e.type === 'recordPoll'));
  });

  it('publishes availability 0 on the first offline result, clearing a stale retained 1', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
      ...connected, { type: 'tick', now: 1, sun: day }, { type: 'statusFetched', ip: IP, now: 1, sun: day, output: null, alarm: null },
    ]);
    assert.ok(effects.some((e) => e.type === 'publishDevice' && e.subtopic === 'availability' && e.payload === '0'));
  });
});

describe('bridge reducer — max power commands', () => {
  const ready = () => run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
    ...connected, ...online, { type: 'infoFetched', ip: IP, now: 1, info },
  ]).state;
  const command = (payload: string): Event => ({ type: 'mqttMessage', topic: 'ez12mqtt/inv/maxPower_W/set', payload });

  it('validates against the hardware limits, not the current setting', () => {
    // The old flag-based index.ts overwrote its `maxPower` limit with the current setting, so after
    // lowering to 600 a later request for 700 was rejected until the next online edge.
    const { effects } = run(ready(), [
      command('600'),
      { type: 'maxPowerSet', ip: IP, requested_W: 600, ok: true },
      { type: 'maxPowerFetched', ip: IP, now: 2, power_W: 600 },
      command('700'),
    ]);
    assert.deepEqual(effects.filter((e) => e.type === 'setMaxPower').map((e) => e.type === 'setMaxPower' && e.power_W), [600, 700]);
  });

  it('accepts HA\'s float form and rejects partial numbers instead of truncating them', () => {
    const { effects } = run(ready(), [command('650.0'), command('600abc'), command('900')]);
    assert.deepEqual(effects.filter((e) => e.type === 'setMaxPower').map((e) => e.type === 'setMaxPower' && e.power_W), [650]);
  });

  it('reports a failed set as a failure, and republishes the real value', () => {
    const { effects } = run(ready(), [{ type: 'maxPowerSet', ip: IP, requested_W: 600, ok: false }]);
    assert.ok(effects.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('failed')));
    assert.ok(effects.some((e) => e.type === 'fetchMaxPower'));
  });
});

describe('bridge reducer — connection and shutdown', () => {
  it('emits no publishes while disconnected', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [...online, { type: 'infoFetched', ip: IP, now: 1, info }]);
    assert.deepEqual(publishedTopics(effects), []);
  });

  it('resends retained state once the broker is back', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [...online, ...connected]);
    assert.ok(effects.some((e) => e.type === 'publishDevice' && e.subtopic === 'availability' && e.payload === '1'));
  });

  it('marks online devices unavailable, then exits, and nothing follows exit', () => {
    const { effects } = run(initialState(settings, [{ ip: IP, nickname: 'inv' }]), [
      ...connected, ...online,
      { type: 'shutdown' },
      // Stragglers after shutdown — a late tick, a late HTTP result — must not produce anything.
      { type: 'tick', now: 9, sun: day },
      { type: 'statusFetched', ip: IP, now: 9, sun: day, output, alarm },
    ]);
    const exit = effects.findIndex((e) => e.type === 'exit');
    const unavailable = effects.findIndex((e) => e.type === 'publishDevice' && e.subtopic === 'availability' && e.payload === '0');
    assert.ok(unavailable !== -1 && unavailable < exit);
    assert.equal(exit, effects.length - 1, 'exit is the last effect ever');
  });
});

describe('bridge reducer — topic parsing', () => {
  it('treats the base topic literally — regex metacharacters in it match nothing extra', () => {
    const dotted = { ...settings, baseTopic: 'home.solar' };
    const { effects } = run(initialState(dotted, [{ ip: IP, nickname: 'inv' }]), [
      ...connected, ...online, { type: 'infoFetched', ip: IP, now: 1, info },
      { type: 'mqttMessage', topic: 'homeXsolar/inv/maxPower_W/set', payload: '600' },
    ]);
    assert.ok(!effects.some((e) => e.type === 'setMaxPower'));
  });
});
