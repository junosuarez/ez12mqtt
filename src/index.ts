/**
 * The runner: owns every timer, socket and HTTP call, and nothing else. All behaviour lives in
 * bridge.ts's pure reducer. Events go in through `dispatch` and are reduced strictly one at a time;
 * the effects that come back are performed here, and slow ones (inverter HTTP) report back later as
 * further events. Because only the reducer changes state, and only from inside the drain loop, the
 * old interleavings — overlapping polls, the restore window racing a poll, shutdown racing its own
 * publishes — have nowhere to happen.
 */
import config from './config.ts';
import { errorMessage, logger } from './logger.ts';
import { recordDeviceOnline, recordPollError, recordPollSuccess, startMetricsServer } from './metrics.ts';
import { EZ1API } from './api.ts';
import { MQTTClient } from './mqtt.ts';
import { discoveryMessages } from './homeassistant.ts';
import { getSunState, type SunState } from './sun.ts';
import { initialState, reduce, type Effect, type Event, type State } from './bridge.ts';

/** How long to collect retained `info` after each (re)connect: MQTT has no "end of retained" marker. */
const RESTORE_WINDOW_MS = 2000;
/** A clean shutdown that hasn't finished by now exits anyway, rather than hang a container stop. */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** Null when no location is configured; the app then polls around the clock. */
function currentSun(): SunState | null {
  if (config.latitude === undefined || config.longitude === undefined) return null;
  return getSunState(config.latitude, config.longitude, config.sunElevationThreshold, config.sunNowOverride);
}

const unixNow = () => Math.floor(Date.now() / 1000);

const mqttClient = new MQTTClient();
let metricsServer: ReturnType<typeof startMetricsServer> = null;
let ticker: NodeJS.Timeout | null = null;
let restoreWindow: NodeJS.Timeout | null = null;

// ---- the event loop ---------------------------------------------------------------------------

let state: State = initialState(
  { baseTopic: config.mqttBaseTopic, homeAssistant: config.homeAssistantEnable },
  config.devices,
);
const queue: Event[] = [];
let draining = false;

/** The only way anything happens. Safe to call from anywhere, including from inside perform(). */
function dispatch(event: Event): void {
  queue.push(event);
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      logger.debug(`event: ${next.type}`, 'ip' in next ? { ip: next.ip } : undefined);
      const result = reduce(state, next);
      state = result.state;
      for (const effect of result.effects) perform(effect);
    }
  } catch (error: unknown) {
    // A throw here is a reducer bug, and state may be half-applied. Restarting beats limping on.
    logger.error('Event loop crashed', { error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined });
    process.exit(1);
  } finally {
    draining = false;
  }
}

/** Runs slow I/O off the loop and reports back as an event. Never rejects: a failure becomes the
 * fallback event, so a device can't be left marked in-flight forever. */
function request(work: () => Promise<Event>, fallback: () => Event): void {
  work()
    .catch((error: unknown) => {
      logger.error('Request failed unexpectedly', { error: errorMessage(error) });
      return fallback();
    })
    .then(dispatch);
}

function perform(effect: Effect): void {
  switch (effect.type) {
    case 'fetchStatus': {
      const { ip, sun } = effect;
      const api = new EZ1API(ip);
      request(
        async () => {
          const output = await api.getOutputData();
          const alarm = await api.getAlarm();
          return { type: 'statusFetched', ip, now: unixNow(), sun, output, alarm };
        },
        () => ({ type: 'statusFetched', ip, now: unixNow(), sun, output: null, alarm: null }),
      );
      return;
    }
    case 'fetchInfo': {
      const { ip } = effect;
      request(
        async () => ({ type: 'infoFetched', ip, now: unixNow(), info: await new EZ1API(ip).getDeviceInfo() }),
        () => ({ type: 'infoFetched', ip, now: unixNow(), info: null }),
      );
      return;
    }
    case 'fetchMaxPower': {
      const { ip } = effect;
      request(
        async () => {
          const power = parseFloat((await new EZ1API(ip).getMaxPower())?.power ?? '');
          return { type: 'maxPowerFetched', ip, now: unixNow(), power_W: Number.isFinite(power) ? power : null };
        },
        () => ({ type: 'maxPowerFetched', ip, now: unixNow(), power_W: null }),
      );
      return;
    }
    case 'setMaxPower': {
      const { ip, power_W } = effect;
      request(
        // EZ1API returns null on any failure rather than throwing.
        async () => ({ type: 'maxPowerSet', ip, requested_W: power_W, ok: (await new EZ1API(ip).setMaxPower(power_W)) !== null }),
        () => ({ type: 'maxPowerSet', ip, requested_W: power_W, ok: false }),
      );
      return;
    }
    case 'publishDevice':
      mqttClient.publishRaw(`${config.mqttBaseTopic}/${effect.address}/${effect.subtopic}`, effect.payload, effect.retain);
      return;
    case 'publishBridgeStatus':
      mqttClient.publishBridgeStatus(effect.online);
      return;
    case 'subscribe':
      mqttClient.subscribe(effect.topic);
      return;
    case 'unsubscribe':
      mqttClient.unsubscribe(effect.topic);
      return;
    case 'announce': {
      logger.info(`Publishing Home Assistant discovery messages for device ${effect.deviceId}`);
      const messages = discoveryMessages({
        baseTopic: config.mqttBaseTopic,
        discoveryPrefix: config.homeAssistantDiscoveryPrefix,
        address: effect.address,
        deviceId: effect.deviceId,
        name: effect.name,
        limits: effect.limits,
      });
      for (const { topic, payload } of messages) mqttClient.publish(topic, payload, true);
      return;
    }
    case 'startRestoreWindow':
      // A reconnect inside the window must not be closed early by the previous connection's timer.
      if (restoreWindow) clearTimeout(restoreWindow);
      restoreWindow = setTimeout(() => {
        restoreWindow = null;
        logger.info('State restoration complete.');
        dispatch({ type: 'restoreWindowClosed' });
      }, RESTORE_WINDOW_MS);
      return;
    case 'recordPoll':
      if (effect.ok) recordPollSuccess(effect.at);
      else recordPollError();
      return;
    case 'recordDeviceOnline':
      recordDeviceOnline(effect.device, effect.online);
      return;
    case 'log':
      logger[effect.level](effect.message);
      return;
    case 'exit':
      void exit();
      return;
    default: {
      const unhandled: never = effect;
      throw new Error(`Unhandled effect: ${JSON.stringify(unhandled)}`);
    }
  }
}

async function exit(): Promise<void> {
  logger.info('Shutting down...');
  if (ticker) clearInterval(ticker);
  if (restoreWindow) clearTimeout(restoreWindow);
  metricsServer?.close();
  setTimeout(() => {
    logger.warn(`Clean shutdown took over ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway.`);
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Awaited, not fire-and-forget: the reducer's final `availability 0` publishes are queued ahead of
  // the DISCONNECT, and exiting before it goes out is how they used to be lost.
  await mqttClient.disconnect();
  process.exit(0);
}

// ---- wiring -----------------------------------------------------------------------------------

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

// mqtt.js emits 'connect' on every successful reconnect, and 'close' on every drop or failed attempt.
mqttClient.on('connect', () => dispatch({ type: 'mqttConnected' }));
mqttClient.on('close', () => dispatch({ type: 'mqttDisconnected' }));
mqttClient.on('message', (topic, payload) => dispatch({ type: 'mqttMessage', topic, payload: payload.toString() }));

// Not awaited: mqtt.js retries internally (see mqtt.ts), and polling must never wait on the broker.
void mqttClient.connect();

// A tick never overlaps a poll in flight — the reducer skips busy devices — so a plain interval is safe.
const tick = () => dispatch({ type: 'tick', now: unixNow(), sun: currentSun() });
tick();
ticker = setInterval(tick, config.pollInterval * 1000);

process.on('SIGINT', () => dispatch({ type: 'shutdown' }));
process.on('SIGTERM', () => dispatch({ type: 'shutdown' }));
