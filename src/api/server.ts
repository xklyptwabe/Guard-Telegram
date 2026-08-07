import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AppConfig } from '../config.js';
import type { DrizzleDatabase } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import type { BackendApiPrincipalConfig } from './access.js';
import { authenticateBackendApiPrincipal } from './access.js';
import { handleAuditReadRequest, type AuditReadApiDependencies } from './auditRead.js';

export interface BackendApiController {
  stop(): Promise<void>;
}

interface BackendApiServerConfig {
  readonly backendApiHost: string;
  readonly backendApiPort: number;
  readonly backendApiPrincipals: readonly BackendApiPrincipalConfig[];
}

export type BackendApiDependencies = AuditReadApiDependencies;

export type BackendApiConfig = Pick<
  AppConfig,
  'backendApiHost' | 'backendApiPort' | 'backendApiPrincipals'
>;

export function createBackendApiRequestHandler(
  config: Pick<BackendApiServerConfig, 'backendApiPrincipals'>,
  deps: BackendApiDependencies,
  logger: Logger,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleBackendApiRequest(request, response, config, deps, logger);
  };
}

export async function startBackendApiServer(
  config: BackendApiConfig,
  db: DrizzleDatabase,
  logger: Logger,
): Promise<BackendApiController> {
  const server = createServer(createBackendApiRequestHandler(config, { db }, logger));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.backendApiPort, config.backendApiHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({
    event: 'backend_api.started',
    details: { host: config.backendApiHost, port: config.backendApiPort },
  });
  return {
    async stop(): Promise<void> {
      await closeServer(server);
      logger.info({ event: 'backend_api.stopped' });
    },
  };
}

async function handleBackendApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Pick<BackendApiServerConfig, 'backendApiPrincipals'>,
  deps: BackendApiDependencies,
  logger: Logger,
): Promise<void> {
  try {
    const principal = authenticateBackendApiPrincipal(
      request.headers.authorization,
      config.backendApiPrincipals,
    );
    if (principal === undefined) {
      writeJson(response, 401, { error: { code: 'unauthorized', message: 'Unauthorized' } });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://backend-api.local');
    logger.debug({
      event: 'backend_api.request',
      userId: principal.actorId,
      details: { method: request.method, path: url.pathname },
    });
    const routed = await handleAuditReadRequest(request.method, url, principal, deps);
    if (routed !== undefined) {
      writeJson(response, routed.statusCode, routed.body);
      return;
    }
    writeJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
  } catch (error: unknown) {
    logger.error({
      event: 'backend_api.request_failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
    });
    writeJson(response, 500, { error: { code: 'internal_error', message: 'Internal error' } });
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
