# Home Assistant Integration Plan

This document outlines the plan to integrate `ez12mqtt` with Home Assistant using MQTT Discovery.

## 1. High-Level Requirements

- **Automatic Discovery:** `ez12mqtt` devices and their entities (sensors, etc.) should be automatically discovered by Home Assistant.
- **Device Availability:** Home Assistant should accurately reflect the online/offline status of each EZ1 microinverter.
- **Configurability:** The integration should be easy to enable and configure.

## 2. Configuration

The following new environment variables will be added:

| Environment Variable             | Description                                             | Default         |
| :------------------------------- | :------------------------------------------------------ | :-------------- |
| `HOMEASSISTANT_ENABLE`           | Set to `true` to enable Home Assistant integration.     | `false`         |
| `HOMEASSISTANT_DISCOVERY_PREFIX` | The MQTT discovery topic prefix used by Home Assistant. | `homeassistant` |

## 3. Availability Topic

A new availability topic will be created for each device:

- **Topic:** `<MQTT_BASE_TOPIC>/<device_topic>/availability`
- **Payload (Online):** `1`
- **Payload (Offline):** `0`
- **Retain:** `true`

This topic will be updated whenever the device's online status changes.
Additionally, a LWT message setting this to `0` will be published when ez12mqtt starts up

## 4. MQTT Discovery

When `HOMEASSISTANT_ENABLE` is `true`, `ez12mqtt` will publish discovery messages for each entity of a device when that device first comes online.

### 4.1. Discovery Topic Format

`<HOMEASSISTANT_DISCOVERY_PREFIX>/<component>/<device_id>/<entity_id>/config`

- `<component>`: `sensor` or `binary_sensor`.
- `<device_id>`: The unique ID of the EZ1 device.
- `<entity_id>`: The unique ID of the entity.

Since EZ1s have entities fixed in their hardware, the entity unique id is the device id joined with the field name

### 4.2. Discovery Payload

A separate discovery message will be published for each entity. Each message will contain a `device` block and an entity-specific configuration.

#### 4.2.1. Common Device Configuration

```json
{
  "device": {
    "identifiers": ["<deviceId>"],
    "name": "<nickname or deviceId>",
    "model": "EZ1 Microinverter",
    "manufacturer": "APsystems"
  },
  "availability_topic": "<MQTT_BASE_TOPIC>/<device_topic>/availability",
  "payload_available": "1",
  "payload_not_available": "0"
}
```

#### 4.2.2. Sensor Entities

This applies to power and energy readings.

**Example: Channel 1 Power**

- **Discovery Topic:** `homeassistant/sensor/E28000000238/channel1Power/config`
- **Payload:**
  ```json
  {
    "name": "Channel 1 Power",
    "unique_id": "E28000000238_channel1Power_W",
    "state_topic": "ez12mqtt/mock_inverter/status",
    "unit_of_measurement": "W",
    "value_template": "{{ value_json.channel1Power_W }}",
    "device_class": "power",
    "state_class": "measurement",
    "device": { ... },
    "availability_topic": "ez12mqtt/mock_inverter/availability",
    "payload_available": "1",
    "payload_not_available": "0"
  }
  ```

#### 4.2.3. Binary Sensor Entities

This applies to alarm statuses.

**Example: Off-Grid Alarm**

- **Discovery Topic:** `homeassistant/binary_sensor/E28000000238/isOffGrid/config`
- **Payload:**
  ```json
  {
    "name": "Off-Grid",
    "unique_id": "E28000000238_isOffGrid",
    "state_topic": "ez12mqtt/mock_inverter/status",
    "value_template": "{{ value_json.isOffGrid }}",
    "payload_on": true,
    "payload_off": false,
    "device_class": "problem",
    "device": { ... },
    "availability_topic": "ez12mqtt/mock_inverter/availability",
    "payload_available": "1",
    "payload_not_available": "0"
  }
  ```

## 5. Implementation Plan

1.  **Update `TDD.md`:** Add a reference to this `HOMEASSISTANT.md` document.
2.  **Update `src/config.ts`:** Add the new `HOMEASSISTANT_*` environment variables.
3.  **Update `src/index.ts`:**
    - Modify the logic to publish to the new `/availability` topic.
    - When a device comes online for the first time, call a new function to publish the discovery messages.
4.  **Create `src/homeassistant.ts`:**
    - This new module will contain the logic for generating and publishing the discovery payloads for all entities of a given device.
5.  **Update `README.md`:** Document the new Home Assistant integration features and configuration.
