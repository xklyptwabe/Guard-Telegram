import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const openApiPath = 'docs/openapi/backend-api.openapi.json';
const requiredPaths = [
  '/api/v1/audit/events',
  '/api/v1/audit/events/{id}',
  '/api/v1/audit/event-types',
  '/api/v1/audit/policies',
  '/api/v1/audit/policies/{id}',
  '/api/v1/audit/exports',
] as const;

describe('backend API OpenAPI document', () => {
  it('is valid JSON and documents every audit backend endpoint', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly openapi?: string;
      readonly paths?: Record<string, unknown>;
      readonly components?: { readonly securitySchemes?: Record<string, unknown> };
    };

    expect(document.openapi).toBe('3.1.0');
    for (const path of requiredPaths) {
      expect(document.paths).toHaveProperty(path);
    }
    expect(document.components?.securitySchemes).toHaveProperty('backendBearerAuth');
  });

  it('documents separate read, policy-management, and export operations', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly paths: Record<string, Record<string, { readonly operationId?: string }>>;
    };

    expect(document.paths['/api/v1/audit/events']?.get?.operationId).toBe('listAuditEvents');
    expect(document.paths['/api/v1/audit/policies/{id}']?.patch?.operationId).toBe('patchAuditPolicy');
    expect(document.paths['/api/v1/audit/exports']?.post?.operationId).toBe('createAuditExport');
  });
});
