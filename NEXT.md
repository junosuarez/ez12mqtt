# Project Summary: ez12mqtt

This document summarizes the development of the `ez12mqtt` project, highlighting its specifications, key architectural decisions, and important pivots made during its implementation.

## 1. Project Specifications

*   **Goal:** To create a Node.js application that polls data from EZ1 microinverters and publishes it to an MQTT server for integration with systems like Home Assistant.
*   **Technology Stack:** Node.js (TypeScript), MQTT, HTTP API communication (axios).
*   **Containerization:** Designed for Docker deployment with configuration via environment variables (12-factor app principles).
*   **Polling:** Polls EZ1 microinverters every 30 seconds for fast-changing data (`getOutputData`, `getAlarm`). Stored info (`getDeviceInfo`, `getMaxPower`) is fetched at startup and on online/offline state changes.
*   **MQTT Topic Structure:**
    *   `<MQTT_BASE_TOPIC>/_status`: Application heartbeat and availability.
    *   `<MQTT_BASE_TOPIC>/<device>/availability`: Device online/offline status.
    *   `<MQTT_BASE_TOPIC>/<device>/info`: Static device information.
    *   `<MQTT_BASE_TOPIC>/<device>/maxPower_W`: Current maximum power setting.
    *   `<MQTT_BASE_TOPIC>/<device>/status`: Real-time operational data (power, energy, alarms) and aggregate metrics.
    *   `<MQTT_BASE_TOPIC>/<device>/maxPower_W/set`: Command topic to set max power.
*   **Data Transformation:** API data is mapped to verbose, self-documenting property names with units (`_W`, `_kWh`, `_s`). Boolean alarms are trivalent (`true`, `false`, `null`).
*   **Home Assistant Integration:** Full MQTT Discovery support, exposing entities as `sensor`, `binary_sensor`, and `number` types, correctly linked to a single device. Includes `availability_topic` for robust device status tracking.
*   **Graceful Shutdown:** Publishes `0` to availability topics on `SIGINT`/`SIGTERM`.

## 2. Key Decisions and Pivots

*   **Node.js & TypeScript:** Chosen for its asynchronous nature and strong typing, enabling efficient, robust development. Native TypeScript execution was prioritized.
*   **Environment Variable Configuration:** Adhering to 12-factor app principles for easy Docker deployment and configuration management.
*   **MQTT Topic Design:**
    *   Transitioned from separate topics per HTTP endpoint to consolidated `info`, `status`, and `maxPower_W` topics for efficiency and logical grouping.
    *   Implemented `_status` topic with LWT for application self-monitoring.
    *   Introduced a dedicated `maxPower_W` topic for the max power setting, separating it from the less frequently updated `info` topic for better MQTT efficiency and UI responsiveness.
*   **Home Assistant MQTT Discovery:**
    *   **Decision:** Fully embrace Home Assistant's MQTT Discovery protocol for automatic entity setup.
    *   **Pivot (Availability Topic):** Initially, `isOnline` was part of the `status` payload. Pivoted to a separate `<device>/availability` topic with `1`/`0` payloads, as per Home Assistant's best practices for availability topics.
    *   **Pivot (Number Entity Range):** Discovered a discrepancy between Home Assistant's core entity model documentation (`native_min_value`, `native_max_value`) and MQTT discovery schema (`min`, `max`). Pivoted to using `min` and `max` in the discovery payload to ensure correct range display in the UI.
    *   **Pivot (`maxPower_W` Control in HA):** Ensured the Home Assistant `number` entity was correctly configured to send the full numerical payload (via `command_template: '{{ value }}'`) for setting max power.
*   **State Restoration on Startup:** Implemented a crucial mechanism for `ez12mqtt` to subscribe to retained messages (`<BASE>/#`) at startup, restoring device `deviceId` and `minPower`/`maxPower` from the broker, before publishing HA discovery messages. This makes the service more resilient to restarts when inverters are temporarily offline.
*   **Testing Strategy with Testcontainers:**
    *   **Challenge:** Initial testing with `docker-compose run` revealed race conditions and ordering issues between the tester and the `ez12mqtt` service.
    *   **Pivot:** Shifted to using [Testcontainers](https://testcontainers.org/) for integration testing. This decision dramatically improved test robustness by allowing programmatic control over container lifecycle, networking, and setup.
    *   **Network Configuration:** Used Testcontainers `Network` feature to ensure containers can communicate reliably by name (e.g., `mqtt-broker`, `mock-ez1`), simplifying network addressing.
    *   **Wait Strategies:** Employed `Wait.forLogMessage` to ensure dependent services are fully started before proceeding with subsequent test steps, avoiding further race conditions.
    *   **Test Configuration:** Centralized test configuration directly within the `e2e.ts` script, avoiding reliance on external `config.ts` for test environment setup.

## 3. Future Considerations

*   **Expanded Control:** Implementation of `setDevicePowerStatus` switch entity.
*   **Robust Error Handling:** More granular error handling for API calls (e.g., retries with backoff).
*   **Multi-Device Testing:** Expand e2e tests to include multiple configured devices.
