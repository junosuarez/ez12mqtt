import { inspect } from 'util';

type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: any; // Allow arbitrary additional properties
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  'DEBUG': 0,
  'INFO': 1,
  'WARN': 2,
  'ERROR': 3,
};

let currentLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'INFO';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function log(level: LogLevel, message: string, context?: Record<string, any>): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[currentLogLevel]) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  // Use inspect to handle circular references in context objects
  console.log(JSON.stringify(entry, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      // Detect circular references
      const cache = new Set();
      return JSON.parse(JSON.stringify(value, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (cache.has(v)) {
            // Circular reference found, discard key
            return;
          }
          // Store value in our collection
          cache.add(v);
        }
        return v;
      }));
    }
    return value;
  }));
}

export const logger = {
  debug: (message: string, context?: Record<string, any>) => log('DEBUG', message, context),
  info: (message: string, context?: Record<string, any>) => log('INFO', message, context),
  warn: (message: string, context?: Record<string, any>) => log('WARN', message, context),
  error: (message: string, context?: Record<string, any>) => log('ERROR', message, context),
};
