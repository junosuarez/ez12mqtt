```
+----------------+         +-----------------+
|   ez12mqtt     |         |   MQTT Broker   |
| (Starts Up)    |         |                 |
+----------------+         +-----------------+
       |                           |
       | 1. Subscribe to           |
       |    `<base_topic>/#`        |
       |-------------------------->|
       |                           |
       |                           | 2. Broker sends retained
       |                           |    messages (e.g., info)
       |<--------------------------|
       |                           |
       | 3. Process retained       |
       |    messages to restore    |
       |    in-memory state        |
       |    (deviceId, etc.)       |
       |                           |
       | 4. Unsubscribe from       |
       |    `<base_topic>/#`        |
       |-------------------------->|
       |                           |
       | 5. Publish HA Discovery   |
       |    messages               |
       |-------------------------->|
       |                           |
       | 6. Begin normal polling   |
       |    loop...                |
       |                           |
```