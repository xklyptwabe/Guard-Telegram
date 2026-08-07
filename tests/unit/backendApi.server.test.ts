import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createBackendApiRequestHandler } from '../../src/api/server.js';
import type { Logger } from '../../src/lib/logger.js';

describe('backend API request handler', () => {
  it('rejects unauthenticated API requests before route dispatch', async () => {
    const result = await dispatch({ authorization: undefined });

    expect(result.statusCode).toBe(401);
    expect(result.body).toContain('"unauthorized"');
  });

  it('accepts authenticated requests and returns not_found for unknown routes', async () => {
    const result = await dispatch({ authorization: 'Bearer test-token-123456' }, '/api/v1/unknown');

    expect(result.statusCode).toBe(404);
    expect(result.body).toContain('"not_found"');
  });
});

async function dispatch(
  headers: { readonly authorization: string | undefined },
  url = '/api/v1/audit/events',
): Promise<{
  readonly statusCode: number;
  readonly body: string;
}> {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const handler = createBackendApiRequestHandler(
    {
      backendApiPrincipals: [
        {
          token: 'test-token-123456',
          actorId: 'operator-1',
          permissions: ['audit.events.read'],
          allowedChatIds: ['chat-1'],
          systemAdmin: false,
        },
      ],
    },
    { db: fakeDb() as never, audit: fakeAudit() as never },
    logger,
  );

  const request = {
    method: 'GET',
    url,
    headers,
  } as unknown as IncomingMessage;

  return new Promise((resolve) => {
    let statusCode = 0;
    let body = '';
    const response = {
      writeHead(code: number) {
        statusCode = code;
        return response;
      },
      end(chunk: string) {
        body += chunk;
        resolve({ statusCode, body });
        return response;
      },
    } as unknown as ServerResponse;

    handler(request, response);
  });
}

function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  };
}

function fakeAudit() {
  return {
    recordEntityChange: async () => ({ eventId: 'event-1', subjectSequence: 1, duplicate: false }),
  };
}
