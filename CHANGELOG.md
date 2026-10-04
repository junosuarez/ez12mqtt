# Changelog

Versions follow [semver](https://semver.org/). Container images are published as
`ghcr.io/junosuarez/ez12mqtt:<version>`, `:<major>.<minor>` and `:<major>`; `:latest` tracks `main`.
Pin a major version to avoid picking up breaking changes unannounced.

## 2.0.0

### Breaking

- **MQTT connects over TLS by default** (`mqtts://`, port 8883, broker certificate verified).
  A broker that only speaks plain MQTT — including a default Mosquitto on port 1883 — now needs
  `MQTT_INSECURE=true`. Without it the bridge can't connect, and logs a hint saying so.

### Added

- `MQTT_INSECURE=true`: connect over plain MQTT (port 1883 by default).
- `MQTT_CA_FILE`: trust a private CA, or a self-signed broker's own certificate.
- `MQTT_CERT_FILE` / `MQTT_KEY_FILE`: client certificate for mutual TLS.
- `MQTT_TLS_SKIP_VERIFY=true`: TLS without certificate verification (encrypted but not
  authenticated; warns at every startup). Prefer `MQTT_CA_FILE`.
- Connection errors include their error code, plus a one-time hint for the common TLS
  misconfigurations.

### Upgrading from 1.x

- Plain-MQTT broker: add `MQTT_INSECURE=true`. If you set `MQTT_PORT=1883` it can stay.
- TLS broker with a publicly trusted certificate: nothing to do. With a private CA or a
  self-signed certificate: set `MQTT_CA_FILE`.

## 1.0.0

The last release before TLS-by-default: plain MQTT unless configured otherwise.
