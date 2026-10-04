import * as mqtt from 'mqtt';
import type { IClientOptions, MqttClient, MqttClientEventCallbacks } from 'mqtt';
import config from './config.ts';
import { logger } from './logger.ts';

type BrokerSettings = Pick<typeof config, 'mqttHost' | 'mqttPort' | 'mqttTls' | 'mqttUser' | 'mqttPassword' | 'mqttBaseTopic'>;

/** Pure: the broker URL and client options for a config, so the TLS/plain split is unit-tested. */
export function brokerConnection(settings: BrokerSettings): { url: string; options: IClientOptions } {
  const tls = settings.mqttTls;
  return {
    url: `${tls ? 'mqtts' : 'mqtt'}://${settings.mqttHost}:${settings.mqttPort}`,
    options: {
      clientId: `ez12mqtt_${Math.random().toString(16).slice(3)}`,
      clean: true,
      connectTimeout: 4000,
      reconnectPeriod: 1000,
      // Plain reconnectPeriod only covers timeouts and drops; a broker that actively rejects the
      // CONNACK (e.g. mid-restart with a stale config) needs this too, or the client can wedge
      // permanently on that one rejected attempt.
      reconnectOnConnackError: true,
      ...(settings.mqttUser && { username: settings.mqttUser }),
      ...(settings.mqttPassword && { password: settings.mqttPassword }),
      ...(tls && {
        // Explicit rather than relying on the default: verification is the whole point, and there's
        // deliberately no setting that turns it off.
        rejectUnauthorized: true,
        ...(tls.ca && { ca: tls.ca }),
        ...(tls.cert && { cert: tls.cert }),
        ...(tls.key && { key: tls.key }),
      }),
      will: {
        topic: `${settings.mqttBaseTopic}/_status`,
        payload: JSON.stringify({ online: false }),
        qos: 1,
        retain: true,
      },
    },
  };
}

type ClientEvent = keyof MqttClientEventCallbacks;

/** A listener held as closures, so the heterogeneous list needs no cast to replay onto a client. */
interface Registration {
  event: ClientEvent;
  listener: unknown; // identity only, for removeListener
  attach(client: MqttClient): void;
}

export class MQTTClient {
  private client: MqttClient | null = null;
  private readonly mqttUrl: string;
  private readonly options: IClientOptions;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Unix ms since the client has been continuously disconnected; null while connected. Starts
   * "disconnected" at construction so a stuck initial connect counts toward the grace period
   * exactly like a dropped one — otherwise a connect that never succeeds looks indistinguishable
   * from one that hasn't been attempted yet. */
  private disconnectedSince: number | null = Date.now();
  /** Listeners registered via on(), replayed onto the underlying client when connect() creates it.
   * main() registers its 'connect' and 'message' handlers before calling connect(), and forwarding
   * to a client that doesn't exist yet silently dropped them. */
  private readonly listeners: Registration[] = [];

  private readonly connectFn: typeof mqtt.connect;

  /** connectFn is injectable so tests can drive a fake client without a real broker or module
   * mocking — Node's strip-only TS mode doesn't support constructor parameter properties. */
  constructor(connectFn: typeof mqtt.connect = mqtt.connect) {
    this.connectFn = connectFn;
    const { url, options } = brokerConnection(config);
    this.mqttUrl = url;
    this.options = options;
  }

  /** Live read for the metrics gauge — reading the client's own flag beats tracking events, which
   * can miss a transition and leave the gauge asserting something untrue. */
  public get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** 0 while connected; otherwise how long the client has been continuously unable to connect.
   * Feeds the /healthz grace period — see metrics.ts. */
  public disconnectedForMs(): number {
    return this.disconnectedSince === null ? 0 : Date.now() - this.disconnectedSince;
  }

  public connect(): Promise<void> {
    return new Promise((resolve) => {
      logger.info(`Attempting to connect to MQTT broker at ${this.mqttUrl}`);
      this.client = this.connectFn(this.mqttUrl, this.options);

      this.client.on('connect', () => {
        logger.info('Successfully connected to MQTT broker.');
        this.disconnectedSince = null;
        // Guarded: mqtt.js emits 'connect' again on every successful reconnect, and this ran
        // unconditionally before — stacking a fresh 30s interval on top of the last one on every
        // broker blip, none of which ever got cleared.
        if (!this.heartbeat) this.startHeartbeat();
        resolve();
      });

      this.client.on('error', (error) => {
        logger.error(`MQTT connection error: ${error.message}`);
        if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
        // NOT client.end() here: that call stops mqtt.js's own reconnect loop entirely (it does
        // not "trigger" one, despite the old comment) — it is exactly why a failed *first* connect
        // attempt, e.g. a connack timeout, could wedge the process indefinitely even with
        // reconnectPeriod configured. Just log and let the client retry.
      });

      this.client.on('reconnect', () => {
        logger.info('Reconnecting to MQTT broker...');
      });

      this.client.on('close', () => {
        // disconnect() clears this.client first, so a null here means we closed it on purpose.
        if (this.client === null) {
          logger.info('MQTT connection closed.');
          return;
        }
        logger.warn('MQTT connection closed.');
        if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
      });

      // After our own handlers, so e.g. disconnectedSince is already cleared when callers see 'connect'.
      for (const registration of this.listeners) {
        registration.attach(this.client);
      }
    });
  }

  // Typed against the client's own event map: a typo'd event name, or a listener whose
  // parameters don't match what that event emits, is a compile error.
  public on<E extends ClientEvent>(event: E, listener: MqttClientEventCallbacks[E]): void {
    this.listeners.push({ event, listener, attach: (client) => client.on(event, listener) });
    this.client?.on(event, listener);
  }

  public removeListener<E extends ClientEvent>(event: E, listener: MqttClientEventCallbacks[E]): void {
    const i = this.listeners.findIndex((r) => r.event === event && r.listener === listener);
    if (i !== -1) this.listeners.splice(i, 1);
    this.client?.removeListener(event, listener);
  }

  public subscribe(topic: string): void {
    if (!this.client || !this.client.connected) {
      logger.warn(`MQTT client not connected. Cannot subscribe to topic: ${topic}`);
      return;
    }

    this.client.subscribe(topic, (error) => {
      if (error) {
        logger.error(`Failed to subscribe to topic ${topic}: ${error.message}`);
      } else {
        if (config.logLevel === 'DEBUG') {
          logger.debug(`Subscribed to topic: ${topic}`);
        }
      }
    });
  }

  public unsubscribe(topic: string): void {
    if (!this.client || !this.client.connected) {
      logger.warn(`MQTT client not connected. Cannot unsubscribe from topic: ${topic}`);
      return;
    }

    this.client.unsubscribe(topic, (error) => {
      if (error) {
        logger.error(`Failed to unsubscribe from topic ${topic}: ${error.message}`);
      }
    });
  }

  /** Retained `<base>/_status`. The LWT covers a crash; a clean shutdown has to say so itself,
   * since a graceful disconnect deliberately doesn't trigger the will. */
  public publishBridgeStatus(online: boolean): void {
    this.publish(`${config.mqttBaseTopic}/_status`, online ? { online, uptime_s: Math.floor(process.uptime()) } : { online }, true);
  }

  private startHeartbeat(): void {
    // Publish immediately and then every 30 seconds. Unref'd: this heartbeat is a nicety for
    // whoever's watching `_status`, not a reason to keep the event loop alive — the metrics
    // server and poll loop already do that, and leaving it ref'd meant a test driving 'connect'
    // on a fake client would hang node --test forever.
    this.publishBridgeStatus(true);
    this.heartbeat = setInterval(() => this.publishBridgeStatus(true), 30 * 1000).unref();
  }

  public publish(topic: string, payload: object, retain: boolean = false): void {
    if (!this.client || !this.client.connected) {
      logger.warn(`MQTT client not connected. Cannot publish to topic: ${topic}`);
      return;
    }

    const payloadString = JSON.stringify(payload);
    this.publishRaw(topic, payloadString, retain);
  }

  public publishRaw(topic: string, payload: string, retain: boolean = false): void {
    if (!this.client || !this.client.connected) {
      logger.warn(`MQTT client not connected. Cannot publish to topic: ${topic}`);
      return;
    }

    this.client.publish(topic, payload, { qos: 0, retain }, (error) => {
      if (error) {
        logger.error(`Failed to publish message to topic ${topic}: ${error.message}`);
      } else {
        if (config.logLevel === 'DEBUG') {
          logger.debug(`Published to MQTT topic: ${topic}`, { payload: payload, retain });
        }
      }
    });
  }

  /** Graceful: publishes already handed to the client are written before the DISCONNECT packet,
   * so awaiting this is what makes "publish availability 0, then exit" actually deliver the 0. */
  public disconnect(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const client = this.client;
    this.client = null;
    if (!client) return Promise.resolve();
    return new Promise((resolve) => {
      client.end(false, {}, () => {
        logger.info('Disconnected from MQTT broker.');
        resolve();
      });
    });
  }
}
