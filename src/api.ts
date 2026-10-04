import { errorMessage, logger } from './logger.ts';

interface ApiResponse<T> {
  data: T;
  message: string;
  deviceId: string;
}

export interface DeviceInfo {
  deviceId: string;
  devVer: string;
  ssid: string;
  ipAddr: string;
  minPower: string;
  maxPower: string;
}

export interface OutputData {
  p1: number;
  e1: number;
  te1: number;
  p2: number;
  e2: number;
  te2: number;
}

export interface MaxPower {
  power: string;
}

export interface AlarmInfo {
  og: string;
  isce1: string;
  isce2: string;
  oe: string;
}

/** Network failures that just mean "the inverter isn't there right now" — expected every night. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']);

const REQUEST_TIMEOUT_MS = 5000;

/** fetch wraps network failures as `TypeError: fetch failed` with the system error as its cause. */
function networkErrorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export class EZ1API {
  private readonly baseUrl: string;
  private readonly ip: string;

  /** The EZ1's local API always listens on 8050; the port is a parameter only so tests can stand in. */
  constructor(ip: string, port = 8050) {
    this.ip = ip;
    this.baseUrl = `http://${ip}:${port}`;
  }

  private async get<T>(endpoint: string): Promise<T | null> {
    const url = `${this.baseUrl}${endpoint}`;
    const requestStartTime = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const responseTime = Date.now() - requestStartTime;
      const body = await response.text();
      if (!response.ok) {
        logger.info(`API Error Response - URL: ${url}, Time: ${responseTime}ms, Status: ${response.status}, Body: ${body}`);
        logger.error(`Error fetching data from ${this.ip}${endpoint}: HTTP ${response.status}`);
        return null;
      }
      logger.debug(`API Response - URL: ${url}, Time: ${responseTime}ms, Status: ${response.status}, Body: ${body}`);

      // The device's envelope, trusted as far as its shape; the fields inside are typed per endpoint.
      const data = JSON.parse(body) as ApiResponse<T>;
      if (data.message === 'SUCCESS') {
        return data.data;
      } else {
        logger.warn(`API call to ${this.ip}${endpoint} returned non-success message: ${data.message}`);
        return null;
      }
    } catch (error: unknown) {
      const responseTime = Date.now() - requestStartTime;
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        logger.info(`API Error Request - URL: ${url}, Time: ${responseTime}ms, No response received.`);
        logger.error(`Error fetching data from ${this.ip}${endpoint}: timeout of ${REQUEST_TIMEOUT_MS}ms exceeded`);
        return null;
      }
      const code = networkErrorCode(error);
      if (code) {
        logger.info(`API Error Request - URL: ${url}, Time: ${responseTime}ms, No response received.`);
      }
      if (code && UNREACHABLE.has(code)) {
        logger.debug(`Device ${this.ip} is offline or unreachable for ${endpoint}.`);
      } else {
        logger.error(`Error fetching data from ${this.ip}${endpoint}: ${code ?? errorMessage(error)}`);
      }
      return null;
    }
  }

  async getDeviceInfo(): Promise<DeviceInfo | null> {
    return this.get<DeviceInfo>('/getDeviceInfo');
  }

  async getOutputData(): Promise<OutputData | null> {
    return this.get<OutputData>('/getOutputData');
  }

  async getMaxPower(): Promise<MaxPower | null> {
    return this.get<MaxPower>('/getMaxPower');
  }

  async getAlarm(): Promise<AlarmInfo | null> {
    return this.get<AlarmInfo>('/getAlarm');
  }

  async setMaxPower(power: number): Promise<MaxPower | null> {
    return this.get<MaxPower>(`/setMaxPower?p=${power}`);
  }
}
