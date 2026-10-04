/**
 * The bridge's behaviour as a pure reducer: `reduce(state, event) → { state, effects }`.
 *
 * index.ts is the runner that owns all I/O: it feeds events (timer ticks, inverter HTTP results,
 * MQTT connect/messages, SIGTERM) into `reduce` ONE AT A TIME, then performs the returned effects in
 * order, turning their results back into events. Nothing else mutates state, so there are no
 * interleavings to reason about: a poll can't overlap the last one, the restore window can't race a
 * poll, and shutdown can't race its own publishes.
 *
 * The types carry the invariants the old flag-based DeviceState kept getting wrong:
 * - A device-scoped publish needs an `Address`, which only `addressOf` mints, and only once the
 *   topic is actually known — so `<base>//availability` (#9) can't be expressed.
 * - Discovery (`announce`) is only emitted in the `ready` connection state, which is entered after
 *   command subscriptions were emitted on `mqttConnected` — so advertising a command topic before
 *   subscribing to it (#14) can't happen.
 * - Hardware limits (from getDeviceInfo) and the current power setting (from getMaxPower) are
 *   separate fields. The previous implementation stored both in one `maxPower`, so lowering the
 *   setting also lowered the limit commands were validated against.
 */
import type { AlarmInfo, DeviceInfo, OutputData } from './api.ts';
import type { SunState } from './sun.ts';

// ---- state ------------------------------------------------------------------------------------

export interface Settings {
  baseTopic: string;
  homeAssistant: boolean;
}

/** A device's topic segment. Branded so it can only come from addressOf(), never from ''. */
export type Address = string & { readonly __brand: 'Address' };

export interface Limits {
  min_W: number;
  max_W: number;
}

/** What getDeviceInfo (or a retained `info` message) told us. */
export interface Identity {
  deviceId: string;
  /** Null when restored from a retained message that lacked them. */
  limits: Limits | null;
}

/** `unknown` until the first poll result; `asleep` is offline-because-it's-dark, not an outage. */
export type Link = 'unknown' | 'online' | 'offline' | 'asleep';

export interface Device {
  readonly ip: string;
  readonly nickname?: string;
  readonly description?: string;
  identity: Identity | null;
  link: Link;
  /** A status fetch is in flight; ticks skip the device until it lands. */
  polling: boolean;
  lastSeenAt: number | null;
  /** Discovery published on the current connection. Reset on every connect. */
  announced: boolean;
}

export type Connection =
  | { kind: 'disconnected' }
  /** Connected; collecting retained `info` until the restore window closes. */
  | { kind: 'restoring' }
  | { kind: 'ready' }
  /** Shutdown has begun: nothing else may be emitted. */
  | { kind: 'stopping' };

export interface State {
  readonly settings: Settings;
  conn: Connection;
  devices: Device[];
}

// ---- events (inputs) --------------------------------------------------------------------------

export type Event =
  | { type: 'tick'; now: number; sun: SunState | null }
  | { type: 'statusFetched'; ip: string; now: number; sun: SunState | null; output: OutputData | null; alarm: AlarmInfo | null }
  | { type: 'infoFetched'; ip: string; now: number; info: DeviceInfo | null }
  | { type: 'maxPowerFetched'; ip: string; now: number; power_W: number | null }
  | { type: 'maxPowerSet'; ip: string; requested_W: number; ok: boolean }
  | { type: 'mqttConnected' }
  | { type: 'mqttDisconnected' }
  | { type: 'mqttMessage'; topic: string; payload: string }
  | { type: 'restoreWindowClosed' }
  | { type: 'shutdown' };

// ---- effects (outputs) ------------------------------------------------------------------------

export type DeviceSubtopic = 'availability' | 'status' | 'info' | 'energy' | 'maxPower_W';

export type Effect =
  | { type: 'fetchStatus'; ip: string; sun: SunState | null }
  | { type: 'fetchInfo'; ip: string }
  | { type: 'fetchMaxPower'; ip: string }
  | { type: 'setMaxPower'; ip: string; power_W: number }
  /** `<base>/<address>/<subtopic>` — the runner composes it; an Address is required to ask. */
  | { type: 'publishDevice'; address: Address; subtopic: DeviceSubtopic; payload: string; retain: boolean }
  | { type: 'publishBridgeStatus'; online: boolean }
  | { type: 'subscribe'; topic: string }
  | { type: 'unsubscribe'; topic: string }
  /** Home Assistant discovery for one device. */
  | { type: 'announce'; address: Address; deviceId: string; name: string; limits: Limits | null }
  | { type: 'startRestoreWindow' }
  | { type: 'recordPoll'; ok: boolean; at: number }
  | { type: 'recordDeviceOnline'; device: string; online: boolean }
  | { type: 'log'; level: 'debug' | 'info' | 'warn'; message: string }
  /** Flush pending publishes, disconnect cleanly, exit. Always the last effect ever emitted. */
  | { type: 'exit' };

export interface Result {
  state: State;
  effects: Effect[];
}

// ---- helpers ----------------------------------------------------------------------------------

export function initialState(settings: Settings, devices: { ip: string; nickname?: string; description?: string }[]): State {
  return {
    settings,
    conn: { kind: 'disconnected' },
    devices: devices.map((d) => ({ ...d, identity: null, link: 'unknown', polling: false, lastSeenAt: null, announced: false })),
  };
}

/** The nickname, else the device ID once known, else null: there is nowhere to publish yet. */
export function addressOf(device: Device): Address | null {
  const segment = device.nickname || device.identity?.deviceId;
  return segment ? (segment as Address) : null;
}

const deviceName = (d: Device) => d.nickname || d.ip;
const isOnline = (link: Link) => link === 'online';
const canPublish = (conn: Connection) => conn.kind === 'restoring' || conn.kind === 'ready';
const commandTopic = (s: Settings, a: Address) => `${s.baseTopic}/${a}/maxPower_W/set`;
const infoWildcard = (s: Settings) => `${s.baseTopic}/+/info`;

function publish(address: Address, subtopic: DeviceSubtopic, payload: object | string, retain: boolean): Effect {
  return { type: 'publishDevice', address, subtopic, retain, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

const availability = (a: Address, link: Link): Effect => publish(a, 'availability', isOnline(link) ? '1' : '0', true);

/** Topic → the segment between `<base>/` and `/<suffix>`, without regex (so the base topic needs
 * no escaping) and only if that segment is a single level. */
function segmentOf(settings: Settings, topic: string, suffix: string): string | null {
  const prefix = `${settings.baseTopic}/`;
  const tail = `/${suffix}`;
  if (!topic.startsWith(prefix) || !topic.endsWith(tail)) return null;
  const segment = topic.slice(prefix.length, topic.length - tail.length);
  return segment && !segment.includes('/') ? segment : null;
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function limitsFrom(min: unknown, max: unknown): Limits | null {
  const min_W = finiteOrNull(min);
  const max_W = finiteOrNull(max);
  return min_W !== null && max_W !== null && min_W <= max_W ? { min_W, max_W } : null;
}

/** Retained `info` is whatever is on the broker, so it's checked rather than trusted. */
function parseRetainedInfo(payload: string): { deviceId: string; ip: string | null; limits: Limits | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.deviceIdentifier !== 'string' || !p.deviceIdentifier) return null;
  return {
    deviceId: p.deviceIdentifier,
    ip: typeof p.deviceIPAddress === 'string' ? p.deviceIPAddress : null,
    limits: limitsFrom(p.minimumPowerOutput_W, p.maximumPowerOutput_W),
  };
}

function statusPayload(d: Device, now: number, sun: SunState | null, skipped: boolean, o: OutputData | null, a: AlarmInfo | null) {
  return {
    observedAt: now,
    isOnline: isOnline(d.link),
    deviceLastSeenAt: d.lastSeenAt,
    ...(sun && {
      sunAzimuth_deg: sun.sunAzimuth_deg,
      sunElevation_deg: sun.sunElevation_deg,
      isSunUp: sun.isSunUp,
      sunriseAt: sun.sunriseAt,
      sunsetAt: sun.sunsetAt,
      isPollSkipped: skipped,
    }),
    channel1Power_W: o ? o.p1 : null,
    channel1EnergySinceStartup_kWh: o ? o.e1 : null,
    channel2Power_W: o ? o.p2 : null,
    channel2EnergySinceStartup_kWh: o ? o.e2 : null,
    totalPower_W: o ? o.p1 + o.p2 : null,
    totalEnergySinceStartup_kWh: o ? o.e1 + o.e2 : null,
    isOffGrid: a ? a.og === '1' : null,
    isOutputFault: a ? a.oe === '1' : null,
    isChannel1ShortCircuit: a ? a.isce1 === '1' : null,
    isChannel2ShortCircuit: a ? a.isce2 === '1' : null,
  };
}

/** Discovery for a device that's addressable and identified, once per connection, only when ready. */
function maybeAnnounce(state: State, d: Device, effects: Effect[]): Device {
  const address = addressOf(d);
  if (!state.settings.homeAssistant || state.conn.kind !== 'ready' || d.announced || !address || !d.identity) return d;
  effects.push({ type: 'announce', address, deviceId: d.identity.deviceId, name: d.nickname || d.identity.deviceId, limits: d.identity.limits });
  return { ...d, announced: true };
}

/** Applies a new identity; when it's what first makes the device addressable, subscribes and
 * publishes availability right away, since nothing could be published before. */
function identify(state: State, d: Device, identity: Identity, effects: Effect[]): Device {
  const wasAddressed = addressOf(d) !== null;
  const next: Device = { ...d, identity };
  const address = addressOf(next)!;
  if (!wasAddressed && canPublish(state.conn)) {
    if (state.settings.homeAssistant) effects.push({ type: 'subscribe', topic: commandTopic(state.settings, address) });
    if (next.link !== 'unknown') effects.push(availability(address, next.link));
  }
  return next;
}

function withDevice(state: State, ip: string, fn: (d: Device) => Device): State {
  return { ...state, devices: state.devices.map((d) => (d.ip === ip ? fn(d) : d)) };
}

// ---- the reducer ------------------------------------------------------------------------------

export function reduce(state: State, event: Event): Result {
  // Shutdown is terminal: whatever arrives afterwards (a late HTTP result, a timer) is dropped.
  if (state.conn.kind === 'stopping') return { state, effects: [] };

  const effects: Effect[] = [];
  const { settings } = state;

  switch (event.type) {
    case 'tick': {
      let next = state;
      for (const d of state.devices) {
        if (d.polling) continue; // the previous poll hasn't landed — never overlap
        if (event.sun && !event.sun.isSunUp) {
          // Dark: the inverter is unpowered. Recorded as a result, not fetched.
          next = applyStatus(next, d.ip, event.now, event.sun, true, null, null, effects);
        } else {
          next = withDevice(next, d.ip, (x) => ({ ...x, polling: true }));
          effects.push({ type: 'fetchStatus', ip: d.ip, sun: event.sun });
        }
      }
      return { state: next, effects };
    }

    case 'statusFetched': {
      const next = applyStatus(state, event.ip, event.now, event.sun, false, event.output, event.alarm, effects);
      return { state: next, effects };
    }

    case 'infoFetched': {
      if (!event.info) return { state, effects };
      const info = event.info;
      let next = withDevice(state, event.ip, (d) => {
        let x = identify(state, d, { deviceId: info.deviceId, limits: limitsFrom(info.minPower, info.maxPower) }, effects);
        const address = addressOf(x)!;
        if (canPublish(state.conn)) {
          effects.push(publish(address, 'info', {
            observedAt: event.now,
            deviceIdentifier: info.deviceId,
            deviceVersion: info.devVer,
            wifiNetworkSSID: info.ssid,
            deviceIPAddress: info.ipAddr,
            minimumPowerOutput_W: x.identity?.limits?.min_W ?? null,
            maximumPowerOutput_W: x.identity?.limits?.max_W ?? null,
            deviceDescription: x.description,
          }, true));
        }
        x = maybeAnnounce(state, x, effects);
        return x;
      });
      return { state: next, effects };
    }

    case 'maxPowerFetched': {
      const d = state.devices.find((x) => x.ip === event.ip);
      const address = d && addressOf(d);
      if (event.power_W !== null && address && canPublish(state.conn)) {
        effects.push(publish(address, 'maxPower_W', { observedAt: event.now, maximumPowerOutput_W: event.power_W }, true));
      }
      return { state, effects };
    }

    case 'maxPowerSet': {
      const d = state.devices.find((x) => x.ip === event.ip);
      if (!d) return { state, effects };
      effects.push(event.ok
        ? { type: 'log', level: 'info', message: `Set max power for ${deviceName(d)} to ${event.requested_W} W` }
        : { type: 'log', level: 'warn', message: `Setting max power for ${deviceName(d)} to ${event.requested_W} W failed` });
      // Either way, publish what the inverter actually reports, so HA's slider shows the truth.
      effects.push({ type: 'fetchMaxPower', ip: d.ip });
      return { state, effects };
    }

    case 'mqttConnected': {
      // Subscriptions FIRST, ahead of anything that could advertise their topics.
      for (const d of state.devices) {
        const address = addressOf(d);
        if (settings.homeAssistant && address) effects.push({ type: 'subscribe', topic: commandTopic(settings, address) });
      }
      effects.push({ type: 'subscribe', topic: infoWildcard(settings) }, { type: 'startRestoreWindow' });
      return {
        state: { ...state, conn: { kind: 'restoring' }, devices: state.devices.map((d) => ({ ...d, announced: false })) },
        effects,
      };
    }

    case 'mqttDisconnected':
      return { state: { ...state, conn: { kind: 'disconnected' } }, effects };

    case 'mqttMessage': {
      if (!canPublish(state.conn)) return { state, effects };

      const command = segmentOf(settings, event.topic, 'maxPower_W/set');
      if (command !== null) return handleCommand(state, command, event.payload, effects);

      const infoSegment = state.conn.kind === 'restoring' ? segmentOf(settings, event.topic, 'info') : null;
      if (infoSegment === null) return { state, effects };
      const retained = parseRetainedInfo(event.payload);
      if (!retained) {
        effects.push({ type: 'log', level: 'warn', message: `Ignoring unusable retained info on ${event.topic}` });
        return { state, effects };
      }
      // Nickname-less devices are addressed BY the device ID being restored, so until it's known
      // the only link to their retained info is the IP they reported.
      const match = state.devices.find((d) => addressOf(d) === infoSegment || (addressOf(d) === null && retained.ip === d.ip));
      if (!match || match.identity) return { state, effects }; // a live getDeviceInfo beats a retained one
      const next = withDevice(state, match.ip, (d) => identify(state, d, { deviceId: retained.deviceId, limits: retained.limits }, effects));
      return { state: next, effects };
    }

    case 'restoreWindowClosed': {
      if (state.conn.kind !== 'restoring') return { state, effects };
      const ready: State = { ...state, conn: { kind: 'ready' } };
      effects.push({ type: 'unsubscribe', topic: infoWildcard(settings) }, { type: 'publishBridgeStatus', online: true });
      // A publish attempted while disconnected was dropped, not queued: resend retained state.
      const devices = ready.devices.map((d) => {
        const address = addressOf(d);
        if (!address) return d;
        if (d.link !== 'unknown') effects.push(availability(address, d.link));
        if (isOnline(d.link)) effects.push({ type: 'fetchInfo', ip: d.ip }, { type: 'fetchMaxPower', ip: d.ip });
        return maybeAnnounce(ready, d, effects);
      });
      return { state: { ...ready, devices }, effects };
    }

    case 'shutdown': {
      if (canPublish(state.conn)) {
        for (const d of state.devices) {
          const address = addressOf(d);
          if (address && isOnline(d.link)) effects.push(availability(address, 'offline'));
        }
        effects.push({ type: 'publishBridgeStatus', online: false });
      }
      effects.push({ type: 'exit' });
      return { state: { ...state, conn: { kind: 'stopping' } }, effects };
    }
  }
}

function applyStatus(
  state: State, ip: string, now: number, sun: SunState | null, skipped: boolean,
  output: OutputData | null, alarm: AlarmInfo | null, effects: Effect[],
): State {
  return withDevice(state, ip, (d) => {
    const link: Link = skipped ? 'asleep' : output ? 'online' : 'offline';
    let x: Device = { ...d, link, polling: false, lastSeenAt: output ? now : d.lastSeenAt };

    if (!skipped) effects.push({ type: 'recordPoll', ok: !!output, at: now });
    effects.push({ type: 'recordDeviceOnline', device: deviceName(x), online: isOnline(link) });

    if (link !== d.link && d.link !== 'unknown') {
      effects.push(link === 'online'
        ? { type: 'log', level: 'info', message: `Device ${deviceName(x)} is now online.` }
        : link === 'asleep'
          ? { type: 'log', level: 'info', message: `Device ${deviceName(x)} is asleep for the night.` }
          : { type: 'log', level: 'warn', message: `Device ${deviceName(x)} went offline.` });
    }

    // Refresh identity on every online edge, and keep retrying while it's unknown.
    if (isOnline(link) && (!isOnline(d.link) || !x.identity)) effects.push({ type: 'fetchInfo', ip });

    const address = addressOf(x);
    if (!address || !canPublish(state.conn)) return x;

    // The first result publishes availability even when it's offline (the old flag-based code
    // didn't): a crash never got to write `0`, and a stale retained `1` would otherwise outlive it
    // until sunrise.
    if (isOnline(link) !== isOnline(d.link) || d.link === 'unknown') effects.push(availability(address, link));
    effects.push(publish(address, 'status', statusPayload(x, now, sun, skipped, output, alarm), false));
    if (output) {
      effects.push(publish(address, 'energy', {
        observedAt: now,
        channel1EnergyLifetime_kWh: output.te1,
        channel2EnergyLifetime_kWh: output.te2,
        totalEnergyLifetime_kWh: output.te1 + output.te2,
      }, true));
      effects.push({ type: 'fetchMaxPower', ip });
    }
    x = maybeAnnounce(state, x, effects);
    return x;
  });
}

function handleCommand(state: State, segment: string, payload: string, effects: Effect[]): Result {
  const d = state.devices.find((x) => addressOf(x) === segment);
  if (!d) {
    effects.push({ type: 'log', level: 'warn', message: `Received setMaxPower command for unknown device: ${segment}` });
    return { state, effects };
  }
  // HA's number entity sends floats ("600.0"); anything that isn't a whole number is rejected
  // rather than truncated the way parseInt("600abc") would.
  const power = Number(payload.trim());
  const limits = d.identity?.limits;
  if (!Number.isInteger(power) || !limits || power < limits.min_W || power > limits.max_W) {
    effects.push({ type: 'log', level: 'warn', message: `Invalid power value received for ${segment}: ${payload}` });
    return { state, effects };
  }
  effects.push({ type: 'setMaxPower', ip: d.ip, power_W: power });
  return { state, effects };
}
