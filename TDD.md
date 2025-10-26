# Technical Design Document: ez12mqtt

## 1. Project Overview

`ez12mqtt` is a Node.js application that polls data from EZ1 microinverters and publishes it to an MQTT server. This allows for easy integration with home automation systems like Home Assistant. The application is designed to be configurable via environment variables, easily distributable as a Docker container, and follows 12-factor app principles.

## 2. Architecture

The application will be a single, long-running Node.js process written in TypeScript. It will consist of the following key components:

*   **Configuration Manager:** Reads and validates configuration from environment variables at startup.
*   **Device Manager:** Manages the list of configured EZ1 devices, including their state (online/offline, last seen, etc.).
*   **Polling Engine:** Periodically fetches data from each configured device based on a defined polling strategy.
*   **API Client:** A simple HTTP client to communicate with the EZ1 device's REST API.
*   **MQTT Publisher:** Connects to the MQTT broker and publishes the data.
*   **Logger:** A simple logger that writes JSON lines to stdout.

The application will not have any inbound network ports, it only makes outbound connections to the EZ1 devices and the MQTT broker.

## 3. Configuration

Configuration will be managed through environment variables.

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `DEVICE_{n}_IP` | The IP address of the {n}th device (1-based index). | (Required) |
| `DEVICE_{n}_NICKNAME` | The nickname of the {n}th device. | |
| `DEVICE_{n}_DESCRIPTION`| The description of the {n}th device. | |
| `MQTT_HOST` | The hostname or IP address of the MQTT broker. | `localhost` |
| `MQTT_PORT` | The port of the MQTT broker. | `1883` |
| `MQTT_USER` | The username for MQTT authentication. | |
| `MQTT_PASSWORD` | The password for MQTT authentication. | |
| `MQTT_BASE_TOPIC` | The base topic for all MQTT messages. | `ez12mqtt` |
| `POLL_INTERVAL` | The interval in seconds to poll the devices. | `30` |
| `LOG_LEVEL` | The log level. Can be `INFO` or `DEBUG`. | `INFO` |

The configuration manager will parse these environment variables and create a list of device configurations. It will log validation information as JSON lines to stdout.

## 4. Core Components

### 4.1. Configuration Manager

*   Responsible for reading and parsing environment variables.
*   Will parse `DEVICE_*` variables to build a list of devices.
*   Will validate the configuration and log errors as JSON lines to stdout before exiting.

### 4.2. Device Manager

*   Holds the list of device configurations and their state.
*   For each device, it will determine the MQTT topic name (nickname if present, otherwise device ID).

### 4.3. Polling Engine

*   At startup, it will fetch `getDeviceInfo` and `getMaxPower` for each device and publish to the `info` topic.
*   It will use `setInterval` to trigger polling of `getOutputData` and `getAlarm` at the configured interval.
*   If a device's online/offline status changes, it will re-fetch `getDeviceInfo` and `getMaxPower` and update the `info` topic.
*   It will then pass the fetched data to the MQTT publisher to be published on the `status` topic.

### 4.4. API Client

*   A simple wrapper around an HTTP client library like `axios`.
*   Will have methods for each API endpoint: `getDeviceInfo`, `getOutputData`, `getMaxPower`, `getAlarm`.
*   It will handle the base URL and extract the `data` property from the response.

### 4.5. MQTT Publisher

*   Uses the `mqtt` library to connect to the MQTT broker.
*   Provides a `publish` method that takes a topic and a payload.
*   Will handle connection and reconnection to the broker.
*   If `LOG_LEVEL` is `DEBUG`, it will log each published message to stdout as a JSON line.

## 5. MQTT Topic Hierarchy

The MQTT topic structure will be consolidated into two topics per device:

*   `<MQTT_BASE_TOPIC>/<device_topic>/info`
*   `<MQTT_BASE_TOPIC>/<device_topic>/status`

*   `<MQTT_BASE_TOPIC>`: The base topic, e.g., `ez12mqtt`.
*   `<device_topic>`: The device's nickname if provided, otherwise the `deviceId` fetched from the device itself.

## 5.1 Process Status Monitoring

The application will publish its own status to a dedicated MQTT topic. This allows for monitoring the health of the `ez12mqtt` process itself.

*   **Topic:** `<MQTT_BASE_TOPIC>/_status`
*   **Payload (Online):** `{"online": true, "uptime": <seconds>}`
    *   `online`: A boolean indicating the process is running.
    *   `uptime`: The process uptime in seconds.
*   **Payload (Offline):** `{"online": false}`
*   **Mechanism:**
    *   The application will publish the "Online" payload to the status topic every 60 seconds. This message will be published with the `retain` flag set to `true`.
    *   The MQTT client will be configured with a "Last Will and Testament" (LWT). If the client disconnects ungracefully, the MQTT broker will automatically publish the "Offline" payload to the status topic. This message will also be published with the `retain` flag set to `true`.

## 6. Data Mapping and Transformation

An `observedAt` timestamp (Unix epoch seconds UTC) will be added to each payload.

### `info` Topic

This topic combines data from `getDeviceInfo` and `getMaxPower`. It is published at startup and when the device's online status changes.

| Original Name | New Name | Description |
| :--- | :--- | :--- |
| `deviceId` | `deviceIdentifier` | The unique identifier of the device. |
| `devVer` | `deviceVersion` | The version of the device firmware. |
| `ssid` | `wifiNetworkSSID` | The SSID of the Wi-Fi network the device is connected to. |
| `ipAddr` | `deviceIPAddress` | The IP address of the device. |
| `minPower` | `minimumPowerOutput_W` | The minimum power output of the device in Watts (numeric). |
| `maxPower` | `maximumPowerOutput_W` | The maximum power output of the device in Watts (numeric). |
| `description` | `deviceDescription` | The user-provided description of the device. |

### `status` Topic

This topic combines data from `getOutputData` and `getAlarm`. It is published at every poll interval.

| Original Name | New Name | Description |
| :--- | :--- | :--- |
| (new) | `isOnline` | `true` if the device is online, `false` otherwise. |
| (new) | `deviceLastSeenAt` | Unix timestamp of the last successful poll. `null` if never seen. |
| `p1` | `channel1Power_W` | The current power of channel 1 in Watts. |
| `e1` | `channel1EnergyToday_kWh` | The energy generated by channel 1 today in kWh. |
| `te1` | `channel1EnergyLifetime_kWh` | The total energy generated by channel 1 in kWh. |
| `p2` | `channel2Power_W` | The current power of channel 2 in Watts. |
| `e2` | `channel2EnergyToday_kWh` | The energy generated by channel 2 today in kWh. |
| `te2` | `channel2EnergyLifetime_kWh` | The total energy generated by channel 2 in kWh. |
| `og` | `isOffGrid` | `true`, `false`, or `null` (unknown). |
| `oe` | `isOutputFault` | `true`, `false`, or `null` (unknown). |
| `isce1` | `isChannel1ShortCircuit` | `true`, `false`, or `null` (unknown). |
| `isce2` | `isChannel2ShortCircuit` | `true`, `false`, or `null` (unknown). |

## 7. Error Handling

*   **Device Unreachable:** The polling engine will detect this and set `isOnline` to `false` in the `status` topic.
*   **MQTT Disconnection:** The MQTT client will automatically try to reconnect.
*   **Invalid API Response:** Errors will be logged as JSON lines to stdout. Alarm flags will be set to `null` if the `/getAlarm` endpoint fails.

## 8. Dockerization and Testing

A `docker-compose.yml` file will be created for integration testing. It will define three services:

1.  `ez12mqtt`: The main application.
2.  `mock-ez1`: A minimal Node.js HTTP server to serve sample API data.
3.  `mqtt-broker`: A lightweight MQTT broker (e.g., `eclipse-mosquitto`).

A `Dockerfile` will be created for the `ez12mqtt` application. It will use a Node.js base image that supports running TypeScript natively.

## 9. Implementation Plan

1.  **Project Initialization:**
    *   `npm init -y`
    *   `npm install mqtt axios dotenv typescript @types/node`
    *   Create `tsconfig.json`.
    *   Create project structure: `src/`, `tests/`.
    *   Create `.gitignore`.

2.  **TypeScript Setup:**
    *   Configure `tsconfig.json` for native TypeScript execution.
    *   Update `package.json` with a start script: `node --loader=ts-node/esm src/index.ts`.

3.  **Logging (`src/logger.ts`):**
    *   Implement a simple JSON line logger.

4.  **Configuration (`src/config.ts`):**
    *   Implement the logic to read and parse environment variables.
    *   Export the configuration object.

5.  **API Client (`src/api.ts`):**
    *   Implement the `EZ1API` class with methods for each endpoint.

6.  **MQTT Client (`src/mqtt.ts`):**
    *   Implement the `MQTTClient` class.

7.  **Main Application (`src/index.ts`):**
    *   Integrate all modules.
    *   Implement the main polling loop with the new polling strategy.

8.  **Mock Server (`tests/mock-ez1-server.ts`):**
    *   Create a simple HTTP server to return sample data.

9.  **Dockerization:**
    *   Create `Dockerfile` for `ez12mqtt`.
    *   Create `docker-compose.yml`.
    *   Create `.dockerignore`.

10. **Documentation:**
    *   Update `README.md` with the new configuration and setup instructions.
