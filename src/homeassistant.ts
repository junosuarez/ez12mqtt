import config from './config.ts';
import { logger } from './logger.ts';
import { MQTTClient } from './mqtt.ts';
import type { DeviceState } from './index.ts';

const components = {
  channel1Power_W: { name: 'Channel 1 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel1EnergySinceStartup_kWh: { name: 'Channel 1 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel1EnergyLifetime_kWh: { name: 'Channel 1 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel2Power_W: { name: 'Channel 2 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel2EnergySinceStartup_kWh: { name: 'Channel 2 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel2EnergyLifetime_kWh: { name: 'Channel 2 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  totalPower_W: { name: 'Total Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W', value_template: '{{ value_json.channel1Power_W + value_json.channel2Power_W }}' },
  totalEnergySinceStartup_kWh: { name: 'Total Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', value_template: '{{ value_json.channel1EnergySinceStartup_kWh + value_json.channel2EnergySinceStartup_kWh }}' },
  totalEnergyLifetime_kWh: { name: 'Total Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', value_template: '{{ value_json.channel1EnergyLifetime_kWh + value_json.channel2EnergyLifetime_kWh }}' },
  isOffGrid: { name: 'Off-Grid', type: 'binary_sensor', device_class: 'problem' },
  isOutputFault: { name: 'Output Fault', type: 'binary_sensor', device_class: 'problem' },
  isChannel1ShortCircuit: { name: 'Channel 1 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
  isChannel2ShortCircuit: { name: 'Channel 2 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
  maxPower_W: { name: 'Max Power', type: 'number', device_class: 'power', unit: 'W', mode: 'box' },
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
      device: device,
      availability_topic: availabilityTopic,
      payload_available: '1',
      payload_not_available: '0',
    };

    if (component.value_template) {
      payload.value_template = component.value_template;
    } else {
      payload.state_topic = `${config.mqttBaseTopic}/${deviceState.mqttTopic}/status`;
      payload.value_template = `{{ value_json.${key} }}`;
    }

    if (component.type === 'sensor') {
      payload.unit_of_measurement = component.unit;
      payload.device_class = component.device_class;
      payload.state_class = component.state_class;
    } else if (component.type === 'binary_sensor') {
      payload.payload_on = true;
      payload.payload_off = false;
      payload.device_class = component.device_class;
    } else if (component.type === 'number') {
      payload.command_topic = `${config.mqttBaseTopic}/${deviceState.mqttTopic}/maxPower_W/set`;
      payload.state_topic = `${config.mqttBaseTopic}/${deviceState.mqttTopic}/info`;
      payload.value_template = `{{ value_json.maximumPowerOutput_W }}`;
      payload.unit_of_measurement = component.unit;
      payload.device_class = component.device_class;
      payload.mode = component.mode;
    }

    mqttClient.publish(discoveryTopic, payload, true);
  }
}
