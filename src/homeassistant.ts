import type { Limits } from './bridge.ts';

// Declared rather than inferred: the entries are heterogeneous, and a union inferred from
// the literal makes each optional property inaccessible on the members lacking it.
interface ComponentDef {
  name: string;
  type: 'sensor' | 'binary_sensor' | 'number';
  device_class: string;
  state_class?: string;
  unit?: string;
  subtopic?: string;
  value_template?: string;
  mode?: string;
}

/** The subset of Home Assistant's MQTT discovery schema this bridge emits. */
interface DiscoveryPayload {
  name: string;
  unique_id: string;
  device: { identifiers: string[]; name: string; model: string; manufacturer: string };
  value_template: string;
  availability_topic?: string;
  payload_available?: string;
  payload_not_available?: string;
  state_topic?: string;
  unit_of_measurement?: string;
  device_class?: string;
  state_class?: string;
  payload_on?: boolean;
  payload_off?: boolean;
  command_topic?: string;
  command_template?: string;
  mode?: string;
  min?: number;
  max?: number;
}

const components: Record<string, ComponentDef> = {
  channel1Power_W: { name: 'Channel 1 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel1EnergySinceStartup_kWh: { name: 'Channel 1 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel1EnergyLifetime_kWh: { name: 'Channel 1 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', subtopic: 'energy', value_template: '{{ value_json.channel1EnergyLifetime_kWh }}' },
  channel2Power_W: { name: 'Channel 2 Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W' },
  channel2EnergySinceStartup_kWh: { name: 'Channel 2 Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh' },
  channel2EnergyLifetime_kWh: { name: 'Channel 2 Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', subtopic: 'energy', value_template: '{{ value_json.channel2EnergyLifetime_kWh }}' },
  totalPower_W: { name: 'Total Power', type: 'sensor', device_class: 'power', state_class: 'measurement', unit: 'W', value_template: '{{ value_json.channel1Power_W + value_json.channel2Power_W }}' },
  totalEnergySinceStartup_kWh: { name: 'Total Energy Since Startup', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', value_template: '{{ value_json.channel1EnergySinceStartup_kWh + value_json.channel2EnergySinceStartup_kWh }}' },
  totalEnergyLifetime_kWh: { name: 'Total Energy Lifetime', type: 'sensor', device_class: 'energy', state_class: 'total_increasing', unit: 'kWh', subtopic: 'energy', value_template: '{{ value_json.totalEnergyLifetime_kWh }}' },
  isOffGrid: { name: 'Off-Grid', type: 'binary_sensor', device_class: 'problem' },
  isOutputFault: { name: 'Output Fault', type: 'binary_sensor', device_class: 'problem' },
  isChannel1ShortCircuit: { name: 'Channel 1 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
  isChannel2ShortCircuit: { name: 'Channel 2 Short Circuit', type: 'binary_sensor', device_class: 'problem' },
  maxPower_W: { name: 'Max Power', type: 'number', device_class: 'power', unit: 'W', mode: 'slider' },
};

export interface DiscoveryTarget {
  baseTopic: string;
  discoveryPrefix: string;
  /** The device's topic segment: its nickname, or its device ID. */
  address: string;
  deviceId: string;
  name: string;
  /** Hardware limits for the Max Power slider; omitted from the payload when unknown. */
  limits: Limits | null;
}

/** Pure: the retained discovery messages for one device. Publishing them is the caller's job. */
export function discoveryMessages(target: DiscoveryTarget): { topic: string; payload: DiscoveryPayload }[] {
  const { baseTopic, discoveryPrefix, address, deviceId } = target;
  const device = {
    identifiers: [deviceId],
    name: target.name,
    model: 'EZ1 Microinverter',
    manufacturer: 'APsystems',
  };

  const availabilityTopic = `${baseTopic}/${address}/availability`;

  return Object.entries(components).map(([key, component]) => {
    const discoveryTopic = `${discoveryPrefix}/${component.type}/${deviceId}/${key}/config`;

    const payload: DiscoveryPayload = {
      name: component.name,
      unique_id: `${deviceId}_${key}`,
      device: device,
      value_template: component.value_template || `{{ value_json.${key} }}`,
    };

    if (component.subtopic !== 'energy') {
      payload.availability_topic = availabilityTopic;
      payload.payload_available = '1';
      payload.payload_not_available = '0';
    }

    const subtopic = component.subtopic || 'status';
    if (component.type !== 'number') {
      payload.state_topic = `${baseTopic}/${address}/${subtopic}`;
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
      payload.command_topic = `${baseTopic}/${address}/maxPower_W/set`;
      payload.command_template = '{{ value }}';
      payload.state_topic = `${baseTopic}/${address}/maxPower_W`;
      payload.value_template = `{{ value_json.maximumPowerOutput_W }}`;
      payload.unit_of_measurement = component.unit;
      payload.device_class = component.device_class;
      payload.mode = component.mode;
      // Note: Home Assistant's MQTT discovery for numbers uses `min` and `max`,
      // which differs from the `native_min_value` and `native_max_value` properties
      // used in the core entity model.
      payload.min = target.limits?.min_W;
      payload.max = target.limits?.max_W;
    }

    return { topic: discoveryTopic, payload };
  });
}
