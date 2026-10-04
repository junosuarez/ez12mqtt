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

  console.log(stringify(entry));
}

/**
 * JSON.stringify that survives circular references in a context object, replacing only true
 * cycles with "[Circular]". Tracks the current path of ancestors rather than every object seen,
 * so the same object appearing twice (a shared reference, not a cycle) is still logged both times.
 */
export function stringify(value: unknown): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _key: string, v: unknown): unknown {
    if (typeof v !== 'object' || v === null) return v;
    // `this` is the object holding v; anything deeper than it on the stack is a finished sibling.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(v)) return '[Circular]';
    ancestors.push(v);
    return v;
  });
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
