import * as mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import config from './config.ts';
import { logger } from './logger.ts';

export class MQTTClient {
  private client: MqttClient | null = null;
  private readonly mqttUrl: string;
  private readonly options: IClientOptions;
  private heartbeatStarted = false;
  /** Unix ms since the client has been continuously disconnected; null while connected. Starts
   * "disconnected" at construction so a stuck initial connect counts toward the grace period
   * exactly like a dropped one — otherwise a connect that never succeeds looks indistinguishable
   * from one that hasn't been attempted yet. */
  private disconnectedSince: number | null = Date.now();

  private readonly connectFn: typeof mqtt.connect;

  /** connectFn is injectable so tests can drive a fake client without a real broker or module
   * mocking — Node's strip-only TS mode doesn't support constructor parameter properties. */
  constructor(connectFn: typeof mqtt.connect = mqtt.connect) {
    this.connectFn = connectFn;
    this.mqttUrl = `mqtt://${config.mqttHost}:${config.mqttPort}`;
    this.options = {
      clientId: `ez12mqtt_${Math.random().toString(16).slice(3)}`,
      clean: true,
      connectTimeout: 4000,
      reconnectPeriod: 1000,
      // Plain reconnectPeriod only covers timeouts and drops; a broker that actively rejects the
      // CONNACK (e.g. mid-restart with a stale config) needs this too, or the client can wedge
      // permanently on that one rejected attempt.
      reconnectOnConnackError: true,
      ...(config.mqttUser && { username: config.mqttUser }),
      ...(config.mqttPassword && { password: config.mqttPassword }),
      will: {
        topic: `${config.mqttBaseTopic}/_status`,
        payload: JSON.stringify({ online: false }),
        qos: 1,
        retain: true,
      },
    };
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
        if (!this.heartbeatStarted) {
          this.heartbeatStarted = true;
          this.startHeartbeat();
        }
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
        logger.warn('MQTT connection closed.');
        if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
      });
    });
  }

  // Derived from the client's own event map: mqtt v5 types its emitter against a fixed set,
  // so a typo'd event name is a compile error rather than a listener that never fires.
  public on<E extends Parameters<MqttClient['on']>[0]>(
    event: E,
    listener: (...args: any[]) => void,
  ): void {
    this.client?.on(event, listener as any);
  }

  public removeListener<E extends Parameters<MqttClient['removeListener']>[0]>(
    event: E,
    listener: (...args: any[]) => void,
  ): void {
    this.client?.removeListener(event, listener as any);
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

  private startHeartbeat(): void {
    const publishStatus = () => {
      const payload = {
        online: true,
        uptime_s: Math.floor(process.uptime()),
      };
      this.publish(`${config.mqttBaseTopic}/_status`, payload, true);
    };

    // Publish immediately and then every 30 seconds. Unref'd: this heartbeat is a nicety for
    // whoever's watching `_status`, not a reason to keep the event loop alive — the metrics
    // server and poll loop already do that, and leaving it ref'd meant a test driving 'connect'
    // on a fake client would hang node --test forever.
    publishStatus();
    setInterval(publishStatus, 30 * 1000).unref();
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

  public disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
      logger.info('Disconnected from MQTT broker.');
    }
  }
}
