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

  it('documents optional backend effective-policy resolution without changing raw items', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly paths: Record<string, Record<string, {
        readonly parameters?: readonly { readonly name?: string }[];
        readonly responses?: Record<string, {
          readonly content?: Record<string, { readonly schema?: { readonly $ref?: string } }>;
        }>;
      }>>;
      readonly components?: { readonly schemas?: Record<string, unknown> };
    };

    const operation = document.paths['/api/v1/audit/policies']?.get;
    expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual([
      'chatId',
      'eventType',
      'eventVersion',
      'moduleId',
    ]);
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/AuditPolicyListResponse',
    );
    expect(document.components?.schemas).toHaveProperty('EffectiveAuditPolicy');
    expect(document.components?.schemas).toHaveProperty('AuditPolicyValueSources');
  });
});
