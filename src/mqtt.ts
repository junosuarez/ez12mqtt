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
    };
  }

  public connect(): void {
    logger.info(`Attempting to connect to MQTT broker at ${this.mqttUrl}`);
    this.client = mqtt.connect(this.mqttUrl, this.options);

    this.client.on('connect', () => {
      logger.info('Successfully connected to MQTT broker.');
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

  public publish(topic: string, payload: object): void {
    if (!this.client || !this.client.connected) {
      logger.warn(`MQTT client not connected. Cannot publish to topic: ${topic}`);
      return;
    }

    const payloadString = JSON.stringify(payload);

    this.client.publish(topic, payloadString, { qos: 0, retain: false }, (error) => {
      if (error) {
        logger.error(`Failed to publish message to topic ${topic}: ${error.message}`);
      } else {
        if (config.logLevel === 'DEBUG') {
          logger.debug(`Published to MQTT topic: ${topic}`, { payload: payload });
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
