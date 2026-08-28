import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { HealthSnapshot } from '../../src/lib/health.js';
import type { Logger } from '../../src/lib/logger.js';
import { createOperationalRequestHandler } from '../../src/ops/server.js';

describe('operational request handler', () => {
  it('serves safe health with no-store caching', async () => {
    const result = await dispatch('/health');

    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    expect(result.body).toContain('"audit"');
    expect(result.body).not.toMatch(/before|after|metadata|payload|telegramContext/);
  });

  it('serves the Prometheus registry content type', async () => {
    const result = await dispatch('/metrics');

    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(result.body).toContain('audit_events_written_total');
  });

  it('returns 503 without exposing errors when metric collection fails', async () => {
    const result = await dispatch('/metrics', true);

    expect(result.statusCode).toBe(503);
    expect(result.body).toContain('"temporarily_unavailable"');
    expect(result.body).not.toContain('database password leaked');
  });

  it('does not expose other routes', async () => {
    const result = await dispatch('/unknown');

    expect(result.statusCode).toBe(404);
  });
});

async function dispatch(path: string, metricsFail = false): Promise<{
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}> {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const handler = createOperationalRequestHandler(
    {
      health: async () => healthySnapshot(),
      metricsRegistry: {
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        metrics: metricsFail
          ? async () => {
              throw new Error('database password leaked');
            }
          : async () => '# TYPE audit_events_written_total counter\n',
      },
    },
    logger,
  );
  const request = { method: 'GET', url: path } as IncomingMessage;

  return new Promise((resolve) => {
    let statusCode = 0;
    let headers: Record<string, string> = {};
    let body = '';
    const response = {
      writeHead(code: number, responseHeaders: Record<string, string>) {
        statusCode = code;
        headers = responseHeaders;
        return response;
      },
      end(chunk: string) {
        body += chunk;
        resolve({ statusCode, headers, body });
        return response;
      },
    } as unknown as ServerResponse;

    handler(request, response);
  });
}

function healthySnapshot(): HealthSnapshot {
  return {
    status: 'ok',
    transport: 'long_polling',
    database: 'ready',
    redis: 'disabled',
    storage: 'disabled',
    rabbitMq: 'disabled',
    audit: {
      status: 'ready',
      recentWriteFailure: false,
      delivery: { pending: 0, failed: 0, oldestPendingAgeSeconds: null },
      externalOperations: {
        pending: 0,
        inProgress: 0,
        retryScheduled: 0,
        auditPending: 0,
        terminalUnknown: 0,
        oldestUnfinishedAgeSeconds: null,
      },
    },
  };
}
