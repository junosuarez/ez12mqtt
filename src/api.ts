import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { logger } from './logger.ts';

interface ApiResponse<T> {
  data: T;
  message: string;
  deviceId: string;
}

interface DeviceInfo {
  deviceId: string;
  devVer: string;
  ssid: string;
  ipAddr: string;
  minPower: string;
  maxPower: string;
}

interface OutputData {
  p1: number;
  e1: number;
  te1: number;
  p2: number;
  e2: number;
  te2: number;
}

interface MaxPower {
  power: string;
}

interface AlarmInfo {
  og: string;
  isce1: string;
  isce2: string;
  oe: string;
}

export class EZ1API {
  private client: AxiosInstance;
  private ip: string;

  constructor(ip: string) {
    this.ip = ip;
    this.client = axios.create({
      baseURL: `http://${ip}:8050`,
      timeout: 5000, // 5 seconds timeout
    });
  }

  private async get<T>(endpoint: string): Promise<T | null> {
    try {
      const response = await this.client.get<ApiResponse<T>>(endpoint);
      if (response.data.message === 'SUCCESS') {
        return response.data.data;
      } else {
        logger.warn(`API call to ${this.ip}${endpoint} returned non-success message: ${response.data.message}`);
        return null;
      }
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH') {
        logger.debug(`Device ${this.ip} is offline or unreachable for ${endpoint}.`);
      } else {
        logger.error(`Error fetching data from ${this.ip}${endpoint}: ${error.message}`);
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
