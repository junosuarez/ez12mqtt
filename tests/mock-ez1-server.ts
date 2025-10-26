import http from 'http';
import { logger } from '../src/logger';

const MOCK_DEVICE_ID = process.env.MOCK_DEVICE_ID || 'E28000000238';
const MOCK_IP_ADDR = process.env.MOCK_IP_ADDR || '10.10.8.81';
const MOCK_MIN_POWER = process.env.MOCK_MIN_POWER || '40';
const MOCK_MAX_POWER = process.env.MOCK_MAX_POWER || '1000';

const MOCK_PORT = parseInt(process.env.MOCK_PORT || '8050', 10);

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  logger.info(`Mock server received request: ${req.url}`);

  if (req.url === '/getDeviceInfo') {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        deviceId: MOCK_DEVICE_ID,
        devVer: 'EZ1-LV 1.0.3',
        ssid: 'mock_ssid',
        ipAddr: MOCK_IP_ADDR,
        minPower: MOCK_MIN_POWER,
        maxPower: MOCK_MAX_POWER,
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url === '/getOutputData') {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        p1: Math.random() * 100,
        e1: Math.random() * 1000,
        te1: Math.random() * 10000,
        p2: Math.random() * 100,
        e2: Math.random() * 1000,
        te2: Math.random() * 10000,
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url === '/getMaxPower') {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        power: MOCK_MAX_POWER,
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url && req.url.startsWith('/setMaxPower')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const p = urlParams.get('p');
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        power: p || MOCK_MAX_POWER,
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url === '/getAlarm') {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        og: Math.random() > 0.9 ? '1' : '0',
        isce1: Math.random() > 0.9 ? '1' : '0',
        isce2: Math.random() > 0.9 ? '1' : '0',
        oe: Math.random() > 0.9 ? '1' : '0',
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'Not Found' }));
  }
});

server.listen(MOCK_PORT, () => {
  logger.info(`Mock EZ1 API server listening on port ${MOCK_PORT}`);
});
