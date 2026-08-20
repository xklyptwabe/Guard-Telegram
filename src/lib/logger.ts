import type { AppConfig } from '../config.js';
import { SERVICE_NAME } from '../constants.js';
import { getUpdateContext } from './context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields {
  readonly module?: string;
  readonly event: string;
  readonly correlationId?: string;
  readonly updateId?: string;
  readonly chatId?: string;
  readonly userId?: string;
  readonly commandName?: string;
  readonly durationMs?: number;
  readonly error?: NormalizedError;
  readonly details?: Record<string, unknown>;
}

export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

const secretKey = /(token|secret|password|authorization|cookie|databaseurl|rabbitmqu?rl|accesskey)/i;
const sensitiveUrl = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;

function redactString(value: string): string {
  return value
    .replace(sensitiveUrl, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:^|[?&;\s])(?:password|passwd|pwd|token|api[_-]?key|secret)\s*[=:]\s*[^\s;&]+/gi, (match) =>
      match.replace(/([=:])\s*[^\s;&]+/, '$1[REDACTED]'),
    )
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
}

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return normalizeError(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(nestedValue)]),
    );
  }
  return value;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message),
      ...(error.stack ? { stack: redactString(error.stack) } : {}),
    };
  }
  return { name: 'UnknownError', message: redactString(String(error)) };
}

export class Logger {
  public constructor(private readonly config: Pick<AppConfig, 'nodeEnv' | 'logLevel'>) {}

  public debug(fields: LogFields): void {
    this.write('debug', fields);
  }

  public info(fields: LogFields): void {
    this.write('info', fields);
  }

  public warn(fields: LogFields): void {
    this.write('warn', fields);
  }

  public error(fields: LogFields): void {
    this.write('error', fields);
  }

  private write(level: LogLevel, fields: LogFields): void {
    if (this.shouldSkip(level)) return;
    const entry = redact({
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      environment: this.config.nodeEnv,
      ...getUpdateContext(),
      ...fields,
    });
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }

  private shouldSkip(level: LogLevel): boolean {
    return ['debug', 'info', 'warn', 'error'].indexOf(level) < ['debug', 'info', 'warn', 'error'].indexOf(this.config.logLevel);
  }
}
