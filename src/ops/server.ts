import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Registry } from '@prometheus-io/client';

import type { AppConfig } from '../config.js';
import type { HealthSnapshot } from '../lib/health.js';
import type { Logger } from '../lib/logger.js';

export interface OperationalServerController {
  stop(): Promise<void>;
}

export interface OperationalServerDependencies {
  readonly health: () => Promise<HealthSnapshot>;
  readonly metricsRegistry: Pick<Registry, 'contentType' | 'metrics'>;
}

export function createOperationalRequestHandler(
  deps: OperationalServerDependencies,
  logger: Logger,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleOperationalRequest(request, response, deps, logger);
  };
}

export async function startOperationalServer(
  config: Pick<AppConfig, 'operationalHost' | 'operationalPort'>,
  deps: OperationalServerDependencies,
  logger: Logger,
): Promise<OperationalServerController> {
  const server = createServer(createOperationalRequestHandler(deps, logger));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.operationalPort, config.operationalHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({
    event: 'operational_server.started',
    details: { host: config.operationalHost, port: config.operationalPort },
  });
  return {
    async stop(): Promise<void> {
      await closeServer(server);
      logger.info({ event: 'operational_server.stopped' });
    },
  };
}

async function handleOperationalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: OperationalServerDependencies,
  logger: Logger,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://operational.local');
  if (request.method !== 'GET') {
    writeJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
    return;
  }

  try {
    if (url.pathname === '/health') {
      const snapshot = await deps.health();
      writeJson(response, snapshot.status === 'unhealthy' ? 503 : 200, snapshot);
      return;
    }
    if (url.pathname === '/metrics') {
      const metrics = await deps.metricsRegistry.metrics();
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': deps.metricsRegistry.contentType,
      });
      response.end(metrics);
      return;
    }
    writeJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
  } catch (error: unknown) {
    logger.error({
      event: 'operational_server.request_failed',
      error: {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      },
      details: { path: url.pathname },
    });
    writeJson(response, 503, { error: { code: 'temporarily_unavailable', message: 'Temporarily unavailable' } });
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
