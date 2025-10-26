import * as mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import config from './config.ts';
import { logger } from './logger.ts';

export class MQTTClient {
  private client: MqttClient | null = null;
  private readonly mqttUrl: string;
  private readonly options: IClientOptions;

  constructor() {
    this.mqttUrl = `mqtt://${config.mqttHost}:${config.mqttPort}`;
    this.options = {
      clientId: `ez12mqtt_${Math.random().toString(16).slice(3)}`,
      clean: true,
      connectTimeout: 4000,
      reconnectPeriod: 1000,
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

  public connect(): void {
    logger.info(`Attempting to connect to MQTT broker at ${this.mqttUrl}`);
    this.client = mqtt.connect(this.mqttUrl, this.options);

    this.client.on('connect', () => {
      logger.info('Successfully connected to MQTT broker.');
      this.startHeartbeat();
    });

    this.client.on('error', (error) => {
      logger.error(`MQTT connection error: ${error.message}`);
      this.client?.end(); // Close client on error to trigger reconnect
    });

    this.client.on('reconnect', () => {
      logger.info('Reconnecting to MQTT broker...');
    });

    this.client.on('close', () => {
      logger.warn('MQTT connection closed.');
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

    // Publish immediately and then every 30 seconds
    publishStatus();
    setInterval(publishStatus, 30 * 1000);
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
