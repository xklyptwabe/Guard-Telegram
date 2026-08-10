import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AUDIT_API_MAX_LIMIT } from '../../src/api/auditFilterValidation.js';
import { validateConfig } from '../../src/config.js';

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

  it('uses the backend API runtime default port in the local server URL', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly servers?: readonly { readonly url?: string }[];
    };
    const runtimeDefaultPort = validateConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: 'postgres://bot:password@db.example.internal:5432/telegram',
    }).backendApiPort;

    expect(document.servers?.[0]?.url).toBe(`http://localhost:${runtimeDefaultPort}`);
  });

  it('uses the runtime audit limit maximum for read and export contracts', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly components?: {
        readonly parameters?: { readonly Limit?: { readonly schema?: { readonly maximum?: number } } };
        readonly schemas?: {
          readonly AuditExportRequest?: {
            readonly properties?: { readonly limit?: { readonly maximum?: number } };
          };
        };
      };
    };

    expect(document.components?.parameters?.Limit?.schema?.maximum).toBe(AUDIT_API_MAX_LIMIT);
    expect(document.components?.schemas?.AuditExportRequest?.properties?.limit?.maximum).toBe(AUDIT_API_MAX_LIMIT);
  });

  it('requires at least one policy field in every AuditPolicyPatchRequest', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      readonly components?: {
        readonly schemas?: {
          readonly AuditPolicyPatchRequest?: RequiredShapeSchema;
        };
      };
    };
    const schema = document.components?.schemas?.AuditPolicyPatchRequest;
    expect(schema).toBeDefined();

    const base = { expectedLockVersion: 2, idempotencyKey: 'openapi-policy-patch' };
    expect(matchesRequiredShape(schema!, base)).toBe(false);

    const individualFields = [
      { enabled: false },
      { siteVisible: true },
      { snapshotMode: 'snapshot' },
      { allowlist: ['chatId'] },
      { masking: ['userId'] },
      { retentionDays: 30 },
      { severity: 'warning' },
      { exportAllowed: true },
    ] as const;
    for (const field of individualFields) {
      expect(matchesRequiredShape(schema!, { ...base, ...field })).toBe(true);
    }
    expect(matchesRequiredShape(schema!, { ...base, enabled: true, retentionDays: 90, exportAllowed: false })).toBe(true);
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

interface RequiredShapeSchema {
  readonly required?: readonly string[];
  readonly anyOf?: readonly { readonly required?: readonly string[] }[];
}

function matchesRequiredShape(schema: RequiredShapeSchema, value: Record<string, unknown>): boolean {
  if (!(schema.required ?? []).every((field) => Object.hasOwn(value, field))) return false;
  if (schema.anyOf === undefined) return true;
  return schema.anyOf.some((alternative) =>
    (alternative.required ?? []).every((field) => Object.hasOwn(value, field)),
  );
}
