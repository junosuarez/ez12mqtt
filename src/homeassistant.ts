import config from './config.ts';
import { logger } from './logger.ts';
import { MQTTClient } from './mqtt.ts';
import type { DeviceState } from './index.ts';

const components = {
  channel1Power_W: { name: 'Channel 1 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel1EnergySinceStartup_kWh: { name: 'Channel 1 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  // Per Home Assistant documentation, lifetime energy consumption should be total_increasing.
  channel1EnergyLifetime_kWh: { name: 'Channel 1 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel2Power_W: { name: 'Channel 2 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel2EnergySinceStartup_kWh: { name: 'Channel 2 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  // Per Home Assistant documentation, lifetime energy consumption should be total_increasing.
  channel2EnergyLifetime_kWh: { name: 'Channel 2 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  isOffGrid: { name: 'Off-Grid', type: 'binary_sensor', device_class: 'problem' },
  isOutputFault: { name: 'Output Fault', type: 'binary_sensor', device_class: 'problem' },
  isChannel1ShortCircuit: { name: 'Channel 1 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
  isChannel2ShortCircuit: { name: 'Channel 2 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
};

export function publishDiscoveryMessages(deviceState: DeviceState, mqttClient: MQTTClient) {
  if (!config.homeAssistantEnable || !deviceState.deviceId) {
    return;
  }

  logger.info(`Publishing Home Assistant discovery messages for device ${deviceState.deviceId}`);

  const device = {
    identifiers: [deviceState.deviceId],
    name: deviceState.nickname || deviceState.deviceId,
    model: 'EZ1 Microinverter',
    manufacturer: 'APsystems',
  };

  const availabilityTopic = `${config.mqttBaseTopic}/${deviceState.mqttTopic}/availability`;

  for (const [key, component] of Object.entries(components)) {
    const discoveryTopic = `${config.homeAssistantDiscoveryPrefix}/${component.type}/${deviceState.deviceId}/${key}/config`;

    const payload: any = {
      name: component.name,
      unique_id: `${deviceState.deviceId}_${key}`,
      state_topic: `${config.mqttBaseTopic}/${deviceState.mqttTopic}/status`,
      value_template: `{{ value_json.${key} }}`,
      device: device,
      availability_topic: availabilityTopic,
      payload_available: '1',
      payload_not_available: '0',
    };

    if (component.type === 'sensor') {
      payload.unit_of_measurement = component.unit;
      payload.device_class = component.device_class;
      payload.state_class = component.state_class;
    } else if (component.type === 'binary_sensor') {
      payload.payload_on = true;
      payload.payload_off = false;
      payload.device_class = component.device_class;
    }

    mqttClient.publish(discoveryTopic, payload, true);
  }
}
