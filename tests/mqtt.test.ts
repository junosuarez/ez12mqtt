import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it, mock } from 'node:test';

// config.ts reads env at import time and exits on invalid input — see metrics.test.ts.
process.env.DEVICE_1_IP ??= '10.0.0.1';
process.env.DEVICE_1_NICKNAME ??= 'test-inverter';

const { MQTTClient } = await import('../src/mqtt.ts');

class FakeMqttClient extends EventEmitter {
  connected = false;
  end = mock.fn(() => {});
  subscribe = mock.fn((_topic: string, cb?: (err: Error | null) => void) => cb?.(null));
  unsubscribe = mock.fn((_topic: string, cb?: (err: Error | null) => void) => cb?.(null));
  publish = mock.fn((_topic: string, _payload: string, _opts: any, cb?: (err: Error | null) => void) => cb?.(null));
}

function newClientWithFake() {
  const fake = new FakeMqttClient();
  const connectFn = mock.fn(() => fake as any);
  const client = new MQTTClient(connectFn as any);
  return { fake, client };
}

describe('MQTTClient reconnect — a failed first connect must not wedge the process', () => {
  it('does not end() the client on a connection error — that stops mqtt.js\'s own reconnect loop', () => {
    const { fake, client } = newClientWithFake();
    client.connect(); // not awaited: the promise only resolves once 'connect' fires

    fake.emit('error', new Error('connack timeout'));

    assert.equal(fake.end.mock.calls.length, 0, 'end() must not be called on error — it kills mqtt.js reconnect, not restart it');
  });

  it('tracks disconnected duration and clears it once connected', async () => {
    const { fake, client } = newClientWithFake();
    client.connect();

    assert.ok(client.disconnectedForMs() >= 0, 'starts disconnected until the first connect event');

    fake.emit('error', new Error('connack timeout'));
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(client.disconnectedForMs() > 0, 'stays disconnected after an error, ready to be probed');

    fake.connected = true;
    fake.emit('connect');
    assert.equal(client.disconnectedForMs(), 0, 'clears once connected');
  });

  it('resolves connect() once, even across repeated connect events from reconnects', async () => {
    const { fake, client } = newClientWithFake();
    const connected = client.connect();

    fake.connected = true;
    fake.emit('connect');
    await connected;

    // A reconnect after a broker blip re-emits 'connect' — must not throw or duplicate heartbeats.
    fake.emit('connect');
    assert.equal(client.disconnectedForMs(), 0);
  });

  it('re-marks disconnected on close, not just on error', () => {
    const { fake, client } = newClientWithFake();
    client.connect();
    fake.connected = true;
    fake.emit('connect');
    assert.equal(client.disconnectedForMs(), 0);

    fake.connected = false;
    fake.emit('close');
    assert.ok(client.disconnectedForMs() >= 0);
    assert.equal(fake.end.mock.calls.length, 0);
  });
});
