import { inspect } from 'util';

type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: Lowercase<LogLevel>;
  message: string;
  [key: string]: unknown; // Allow arbitrary additional properties
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

type LogContext = Record<string, unknown>;

function log(level: LogLevel, message: string, context?: LogContext): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[currentLogLevel]) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    // Lowercase in the OUTPUT, uppercase in the code. Loki's level detection matches lowercase
    // values, so `"level":"INFO"` was landing as detected_level=unknown and losing the ability to
    // filter or alert on error rates. The LogLevel type stays uppercase because the ordering table
    // and every call site use it.
    level: level.toLowerCase() as Lowercase<LogLevel>,
    message,
    ...context,
  };

  // Use inspect to handle circular references in context objects
  console.log(JSON.stringify(entry, (key, value: unknown): unknown => {
    if (typeof value === 'object' && value !== null) {
      // Detect circular references
      const cache = new Set();
      return JSON.parse(JSON.stringify(value, (k, v: unknown): unknown => {
        if (typeof v === 'object' && v !== null) {
          if (cache.has(v)) {
            // Circular reference found, discard key
            return;
          }
          // Store value in our collection
          cache.add(v);
        }
        return v;
      })) as unknown;
    }
    return value;
  }));
}

export const logger = {
  debug: (message: string, context?: LogContext) => log('DEBUG', message, context),
  info: (message: string, context?: LogContext) => log('INFO', message, context),
  warn: (message: string, context?: LogContext) => log('WARN', message, context),
  error: (message: string, context?: LogContext) => log('ERROR', message, context),
};

/** For logging a caught value, which TypeScript rightly types as unknown: anything can be thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
