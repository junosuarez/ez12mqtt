# ez12mqtt

`ez12mqtt` is a Node.js application that polls data from EZ1 microinverters and publishes it to an MQTT server. This allows for easy integration with home automation systems like Home Assistant.

## Features

*   Polls EZ1 microinverter data (device info, output data, alarms).
*   Publishes data to MQTT with a structured topic hierarchy.
*   Configurable via environment variables.
*   Dockerized for easy deployment.
*   Supports multiple EZ1 devices.
*   Transforms API response data into verbose, self-documenting MQTT payloads.
*   Includes `observedAt` timestamp in MQTT payloads.
*   Detects device online/offline status and publishes accordingly.

## Configuration

`ez12mqtt` is configured using environment variables. Below is a list of available environment variables:

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `DEVICE_{n}_IP` | The IP address of the {n}th device (1-based index). | (Required) |
| `DEVICE_{n}_NICKNAME` | The nickname of the {n}th device. This will be used in the MQTT topic. | |
| `DEVICE_{n}_DESCRIPTION`| The description of the {n}th device. | |
| `MQTT_HOST` | The hostname or IP address of the MQTT broker. | `localhost` |
| `MQTT_PORT` | The port of the MQTT broker. | `1883` |
| `MQTT_USER` | The username for MQTT authentication. | |
| `MQTT_PASSWORD` | The password for MQTT authentication. | |
| `MQTT_BASE_TOPIC` | The base topic for all MQTT messages. | `ez12mqtt` |
| `POLL_INTERVAL` | The interval in seconds to poll the fast-changing device data (`getOutputData`, `getAlarm`). | `30` |
| `LOG_LEVEL` | The log level for the application. Can be `INFO` or `DEBUG`. | `INFO` |

### Example Configuration

```bash
DEVICE_1_IP=192.168.1.100
DEVICE_1_NICKNAME=inverter_garage
DEVICE_1_DESCRIPTION="EZ1 Microinverter in the garage"
DEVICE_2_IP=192.168.1.101
MQTT_HOST=my-mqtt-broker
MQTT_PORT=1883
MQTT_USER=mqttuser
MQTT_PASSWORD=mqttpass
MQTT_BASE_TOPIC=home/solar
POLL_INTERVAL=10
LOG_LEVEL=DEBUG
```

## MQTT Topic Structure

Data is published to two main topics per device:

*   `<MQTT_BASE_TOPIC>/<device_topic>/info`
*   `<MQTT_BASE_TOPIC>/<device_topic>/status`

Where `<device_topic>` is the `DEVICE_{n}_NICKNAME` if provided, otherwise it will be the `deviceId` fetched from the device itself.

## Running with Docker Compose (for Testing)

To run `ez12mqtt` along with a mock EZ1 API server and an MQTT broker for testing purposes, you can use the provided `docker-compose.yml` file.

1.  **Build and Run:**

    ```bash
    docker compose up --build
    ```

    This will:
    *   Build the `ez12mqtt` application image.
    *   Build the `mock-ez1` server image.
    *   Start an `eclipse-mosquitto` MQTT broker.
    *   Start the `mock-ez1` server, simulating an EZ1 microinverter at `http://mock-ez1:8050`.
    *   Start the `ez12mqtt` application, configured to connect to the `mock-ez1` server and the `mqtt-broker`.

2.  **Run MQTT Tester:**

    To run the end-to-end MQTT assertion test, execute the `mqtt-tester` service:

    ```bash
    docker compose run mqtt-tester
    ```

3.  **Check Logs:**

    You can view the logs of any service using:

    ```bash
    docker compose logs -f ez12mqtt
    docker compose logs -f mock-ez1
    docker compose logs -f mqtt-broker
    ```

4.  **Stop Services:**

    ```bash
    docker compose down
    ```

### Running with Podman Compose

If you are using `podman-compose` instead of `docker compose`, you can run the services similarly:

1.  **Build and Run:**

    ```bash
    podman compose up --build
    ```

2.  **Run MQTT Tester:**

    ```bash
    podman compose run mqtt-tester
    ```

3.  **Check Logs:**

    ```bash
    podman compose logs -f ez12mqtt
    podman compose logs -f mock-ez1
    podman compose logs -f mqtt-broker
    ```

4.  **Stop Services:**

    ```bash
    podman compose down
    ```

## Development

### Prerequisites

*   Node.js (v20 or later)
*   npm

### Installation

1.  Clone the repository:

    ```bash
    git clone <repository-url>
    cd ez12mqtt
    ```

2.  Install dependencies:

    ```bash
    npm install
    ```

### Running Locally

1.  Create a `.env` file in the project root with your desired configuration (e.g., `DEVICE_1_IP=127.0.0.1`, `MQTT_HOST=localhost`).

2.  Start the application:

    ```bash
    npm start
    ```

    If you want to run the mock server locally for testing:

    ```bash
    node --experimental-strip-types tests/mock-ez1-server.ts
    ```

    And then configure `DEVICE_1_IP=127.0.0.1` in your `.env` for `ez12mqtt`.

## Home Assistant Integration

`ez12mqtt` supports MQTT Discovery for seamless integration with Home Assistant.

### Enabling Home Assistant Integration

To enable Home Assistant integration, set the following environment variables:

| Environment Variable             | Description                                             | Default         |
| :------------------------------- | :------------------------------------------------------ | :-------------- |
| `HOMEASSISTANT_ENABLE`           | Set to `true` to enable Home Assistant integration.     | `false`         |
| `HOMEASSISTANT_DISCOVERY_PREFIX` | The MQTT discovery topic prefix used by Home Assistant. | `homeassistant` |

### Availability Topic

When Home Assistant integration is enabled, a separate availability topic is published for each device:

*   **Topic:** `<MQTT_BASE_TOPIC>/<device_topic>/availability`
*   **Payload (Online):** `1`
*   **Payload (Offline):** `0`

This allows Home Assistant to accurately track the online/offline status of each device.

## Data Transformation Details

### `info` Topic Payload

Published at startup and when device online/offline status changes.

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `observedAt` | `number` | Unix epoch seconds UTC when the data was observed. |
| `deviceIdentifier` | `string` | The unique identifier of the device. |
| `deviceVersion` | `string` | The version of the device firmware. |
| `wifiNetworkSSID` | `string` | The SSID of the Wi-Fi network the device is connected to. |
| `deviceIPAddress` | `string` | The IP address of the device. |
| `minimumPowerOutput_W` | `number` | The minimum power output of the device in Watts. |
| `maximumPowerOutput_W` | `number` | The maximum power output of the device in Watts. |
| `deviceDescription` | `string` | The user-provided description of the device. |

### `status` Topic Payload

Published at every poll interval.

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `observedAt` | `number` | Unix epoch seconds UTC when the data was observed. |
| `isOnline` | `boolean` | `true` if the device is online, `false` otherwise. |
| `deviceLastSeenAt` | `number | null` | Unix timestamp of the last successful poll. `null` if never seen. |
| `channel1Power_W` | `number | null` | The current power of channel 1 in Watts. `null` if not available. |
| `channel1EnergyToday_kWh` | `number | null` | The energy generated by channel 1 today in kWh. `null` if not available. |
| `channel1EnergyLifetime_kWh` | `number | null` | The total energy generated by channel 1 in kWh. `null` if not available. |
| `channel2Power_W` | `number | null` | The current power of channel 2 in Watts. `null` if not available. |
| `channel2EnergyToday_kWh` | `number | null` | The energy generated by channel 2 today in kWh. `null` if not available. |
| `channel2EnergyLifetime_kWh` | `number | null` | The total energy generated by channel 2 in kWh. `null` if not available. |
| `isOffGrid` | `boolean | null` | `true` if off-grid alarm, `false` if normal, `null` if unknown. |
| `isOutputFault` | `boolean | null` | `true` if output fault alarm, `false` if normal, `null` if unknown. |
| `isChannel1ShortCircuit` | `boolean | null` | `true` if DC 1 short circuit alarm, `false` if normal, `null` if unknown. |
| `isChannel2ShortCircuit` | `boolean | null` | `true` if DC 2 short circuit alarm, `false` if normal, `null` if unknown. |
