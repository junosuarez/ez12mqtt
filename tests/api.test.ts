import { strict as assert } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { EZ1API } from '../src/api.ts';

// A stand-in EZ1: each path answers the way a real (or broken) device might.
const routes: Record<string, (res: http.ServerResponse) => void> = {
  '/getMaxPower': (res) => res.end(JSON.stringify({ data: { power: '600' }, message: 'SUCCESS', deviceId: 'E1' })),
  '/getAlarm': (res) => res.end(JSON.stringify({ data: {}, message: 'FAILED', deviceId: 'E1' })),
  '/getOutputData': (res) => res.writeHead(500).end('boom'),
  '/getDeviceInfo': (res) => res.end('<html>not json</html>'),
};

let server: http.Server;
let port: number;

before(async () => {
  server = http.createServer((req, res) => (routes[req.url ?? ''] ?? ((r) => r.writeHead(404).end()))(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

describe('EZ1API — every failure is null, never a throw', () => {
  it('returns the data of a SUCCESS envelope', async () => {
    assert.deepEqual(await new EZ1API('127.0.0.1', port).getMaxPower(), { power: '600' });
  });

  it('returns null for a non-SUCCESS envelope', async () => {
    assert.equal(await new EZ1API('127.0.0.1', port).getAlarm(), null);
  });

  it('returns null for an HTTP error status', async () => {
    assert.equal(await new EZ1API('127.0.0.1', port).getOutputData(), null);
  });

  it('returns null for a body that isn\'t JSON', async () => {
    assert.equal(await new EZ1API('127.0.0.1', port).getDeviceInfo(), null);
  });

  it('returns null when nothing is listening', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    assert.equal(await new EZ1API('127.0.0.1', deadPort).getOutputData(), null);
  });
});
