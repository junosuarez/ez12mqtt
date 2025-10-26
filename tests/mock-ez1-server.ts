import http from 'http';
import { logger } from '../src/logger.ts';

const MOCK_DEVICE_ID = process.env.MOCK_DEVICE_ID || 'E28000000238';
const MOCK_IP_ADDR = process.env.MOCK_IP_ADDR || '10.10.8.81';
const MOCK_MIN_POWER = process.env.MOCK_MIN_POWER || '40';
const MOCK_MAX_POWER = process.env.MOCK_MAX_POWER || '1000';

const MOCK_PORT = parseInt(process.env.MOCK_PORT || '8050', 10);

// In-process state for the mock device
const state = {
  p1: 50, // Initial power for channel 1 in Watts
  p2: 50, // Initial power for channel 2 in Watts
  e1: 10, // Initial energy for channel 1 in kWh
  te1: 1000, // Initial total energy for channel 1 in kWh
  e2: 10, // Initial energy for channel 2 in kWh
  te2: 1000, // Initial total energy for channel 2 in kWh
  lastRequestTime: Date.now(),
  currentMaxPower: parseInt(MOCK_MAX_POWER, 10), // Initial max power
};

// Simple Markov Chain for power simulation
type PowerState = 'Low' | 'Medium' | 'High';
let powerState1: PowerState = 'Low';
let powerState2: PowerState = 'Low';

const transitions: Record<PowerState, Record<PowerState, number>> = {
  Low: { Low: 0.7, Medium: 0.3, High: 0.0 },
  Medium: { Low: 0.2, Medium: 0.6, High: 0.2 },
  High: { Low: 0.1, Medium: 0.3, High: 0.6 },
};

function getNextPowerState(currentState: PowerState): PowerState {
  const rand = Math.random();
  let cumulativeProb = 0;
  for (const [nextState, prob] of Object.entries(transitions[currentState])) {
    cumulativeProb += prob;
    if (rand < cumulativeProb) {
      return nextState as PowerState;
    }
  }
  return currentState; // Should not be reached
}

function generatePower(powerState: PowerState): number {
  switch (powerState) {
    case 'Low':
      return Math.random() * 100; // 0-100W
    case 'Medium':
      return 100 + Math.random() * 300; // 100-400W
    case 'High':
      return 400 + Math.random() * 400; // 400-800W
  }
}

function updateState() {
  const now = Date.now();
  const timeDeltaSeconds = (now - state.lastRequestTime) / 1000;
  state.lastRequestTime = now;

  // Calculate energy generated since last request
  const energyDelta1_kWh = (state.p1 * timeDeltaSeconds) / (3600 * 1000);
  const energyDelta2_kWh = (state.p2 * timeDeltaSeconds) / (3600 * 1000);

  state.e1 += energyDelta1_kWh;
  state.te1 += energyDelta1_kWh;
  state.e2 += energyDelta2_kWh;
  state.te2 += energyDelta2_kWh;

  // Update power state and generate new power values
  powerState1 = getNextPowerState(powerState1);
  powerState2 = getNextPowerState(powerState2);
  state.p1 = generatePower(powerState1);
  state.p2 = generatePower(powerState2);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Simulate network delay, random number between 100 and 700ms
  const delay = Math.floor(Math.random() * 600) + 100;
  logger.info(`Mock server received request: ${req.url} (delay: ${delay}ms)`);
  await sleep(delay);

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
    updateState();
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        p1: state.p1,
        e1: state.e1,
        te1: state.te1,
        p2: state.p2,
        e2: state.e2,
        te2: state.te2,
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url === '/getMaxPower') {
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        power: state.currentMaxPower.toString(),
      },
      message: 'SUCCESS',
      deviceId: MOCK_DEVICE_ID,
    }));
  } else if (req.url && req.url.startsWith('/setMaxPower')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const p = urlParams.get('p');
    if (p) {
      state.currentMaxPower = parseInt(p, 10);
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      data: {
        power: state.currentMaxPower.toString(),
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