import http from 'node:http';
import type { Server } from 'node:http';
import config from './config.ts';
import { logger } from './logger.ts';

/**
 * Prometheus metrics, exposed only when METRICS_PORT is set.
 *
 * WHY THIS EXISTS. ez12mqtt is a pure outbound poller: it opens connections to the inverter and to
 * MQTT and listens on nothing. That means it is not a scrape target, so there is no `up` series and
 * a monitoring system cannot tell "running fine" from "process wedged". Exposing a handful of
 * metrics is the only way to make it observable at all; there is no external check that substitutes.
 *
 * WHY THE PORT IS OPT-IN. No default. Unset METRICS_PORT and no listener is created, so the "no
 * inbound ports" property this app was designed around still holds for anyone who does not want the
 * endpoint. Turning it on is a deliberate act.
 *
 * Hand-rolled rather than pulling in prom-client: the exposition format needed here is a few gauges
 * and counters, and a dependency-free module is one less thing in the supply chain for a service
 * whose whole job is polling an inverter on the LAN.
 */

/** Serialised at scrape time, so a missed state transition cannot leave a gauge lying. */
export interface MetricSources {
  /** Live read of the MQTT client's own connected flag — not a remembered event. */
  mqttConnected: () => boolean;
  /**
   * False when the sun is below the configured threshold, i.e. polling is deliberately skipped.
   * THE load-bearing signal for alerting: see pollLastSuccess below.
   */
  pollingExpected: () => boolean;
  sunElevationDeg: () => number | null;
  /** 0 while MQTT is connected; otherwise ms of continuous disconnection. Drives /healthz. */
  mqttDisconnectedForMs: () => number;
}

/**
 * How long MQTT can be continuously unreachable before /healthz starts failing.
 *
 * Long enough that an ordinary broker restart (seconds) never flaps the probe; short enough that a
 * wedged reconnect loop gets caught in about a minute by k8s's own liveness/readiness checks,
 * instead of running indefinitely with the pod stuck at `Ready: true`.
 */
export const MQTT_HEALTHY_GRACE_MS = 60_000;

export const counters = {
  polls: 0,
  pollErrors: 0,
};

/**
 * Unix seconds of the last poll that actually reached the inverter and got data.
 *
 * Deliberately NOT touched when a poll is skipped for darkness. The EZ1 is powered by its own PV
 * input, so it is genuinely offline every night and a skipped poll is not a successful one — writing
 * a timestamp there would be a comfortable lie. The consequence is that this value is ~10 hours stale
 * by dawn, which is why `ez12mqtt_polling_expected` exists: alert on staleness ONLY while polling is
 * expected, or the alert fires every night forever and gets muted, which is worse than no alert.
 */
export let pollLastSuccess = 0;

/** Per-device reachability — the inverter dependency edge. */
export const deviceOnline = new Map<string, boolean>();

export function recordPollSuccess(now: number = Math.floor(Date.now() / 1000)): void {
  counters.polls += 1;
  pollLastSuccess = now;
}

export function recordPollError(): void {
  counters.polls += 1;
  counters.pollErrors += 1;
}

export function recordDeviceOnline(device: string, online: boolean): void {
  deviceOnline.set(device, online);
}

/** Only `\`, `"` and newline are special in a Prometheus label value. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function metricsText(sources: MetricSources): string {
  const lines: string[] = [
    // Unprefixed and named exactly as bop's, on purpose: it is cave's cross-service convention for
    // "my MQTT dependency is up", so this pod joins the shared broker dashboard panel and the
    // existing alert shape without either of them learning about ez12mqtt.
    '# HELP mqtt_connected 1 if the mqtt client is connected, 0 if not.',
    '# TYPE mqtt_connected gauge',
    `mqtt_connected ${sources.mqttConnected() ? 1 : 0}`,

    '# HELP ez12mqtt_poll_last_success_timestamp_seconds Unix time of the last poll that reached the inverter.',
    '# TYPE ez12mqtt_poll_last_success_timestamp_seconds gauge',
    `ez12mqtt_poll_last_success_timestamp_seconds ${pollLastSuccess}`,

    '# HELP ez12mqtt_polling_expected 1 when the inverter should be reachable (sun up), 0 when polling is skipped.',
    '# TYPE ez12mqtt_polling_expected gauge',
    `ez12mqtt_polling_expected ${sources.pollingExpected() ? 1 : 0}`,

    '# HELP ez12mqtt_polls_total Polls attempted.',
    '# TYPE ez12mqtt_polls_total counter',
    `ez12mqtt_polls_total ${counters.polls}`,

    '# HELP ez12mqtt_poll_errors_total Polls that failed to reach the inverter.',
    '# TYPE ez12mqtt_poll_errors_total counter',
    `ez12mqtt_poll_errors_total ${counters.pollErrors}`,
  ];

  const elevation = sources.sunElevationDeg();
  if (elevation !== null) {
    lines.push(
      '# HELP ez12mqtt_sun_elevation_degrees Solar elevation, the input to polling_expected.',
      '# TYPE ez12mqtt_sun_elevation_degrees gauge',
      `ez12mqtt_sun_elevation_degrees ${elevation}`,
    );
  }

  if (deviceOnline.size > 0) {
    lines.push(
      '# HELP ez12mqtt_device_online 1 if the last poll of this inverter returned data.',
      '# TYPE ez12mqtt_device_online gauge',
    );
    for (const [device, online] of deviceOnline) {
      lines.push(`ez12mqtt_device_online{device="${escapeLabel(device)}"} ${online ? 1 : 0}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Starts the exposition endpoint, or returns null when METRICS_PORT is unset.
 *
 * Binds all interfaces because the consumer is a Prometheus pod elsewhere in the cluster; there is
 * nothing secret here (device reachability and counters), and it is reachable only inside the pod
 * network unless a Service is put in front of it.
 */
export function startMetricsServer(sources: MetricSources): Server | null {
  if (config.metricsPort === undefined) {
    logger.info('METRICS_PORT is not set — metrics endpoint disabled, no inbound port opened.');
    return null;
  }

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0].replace(/\/+$/, '');

    if (path === '/healthz') {
      const disconnectedForMs = sources.mqttDisconnectedForMs();
      const healthy = disconnectedForMs < MQTT_HEALTHY_GRACE_MS;
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' })
        .end(healthy ? 'ok' : `mqtt disconnected for ${Math.round(disconnectedForMs / 1000)}s`);
      return;
    }

    if (path !== '/metrics' && path !== '') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
      .end(metricsText(sources));
  });

  // A metrics endpoint must never be able to take down the thing it measures.
  server.on('error', (error) => {
    logger.error(`Metrics server error: ${error.message}`);
  });

  server.listen(config.metricsPort, () => {
    logger.info(`Metrics available on :${config.metricsPort}/metrics`);
  });

  return server;
}
