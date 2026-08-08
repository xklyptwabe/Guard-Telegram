import { z } from 'zod';

import type { DrizzleDatabase } from '../db/client.js';
import {
  AuditExportPolicyError,
  createAuditExport,
} from '../lib/audit/exportService.js';
import type { AuditEventsReadFilters, AuditEventsReadScope } from '../lib/audit/eventReadRepository.js';
import type { AuditService } from '../lib/auditService.js';
import type { BackendApiPrincipal } from './access.js';
import { hasBackendApiPermission } from './access.js';
import { auditFilterDateTimeSchema } from './auditFilterValidation.js';
import { badRequest, forbidden, type ApiResponse } from './responses.js';

const eventCategorySchema = z.enum([
  'module',
  'chat',
  'audit',
  'member',
  'bot',
  'moderation',
  'message',
  'command',
  'integration',
]);
const eventStatusSchema = z.enum(['recorded', 'failed']);
const exportFormatSchema = z.enum(['json', 'csv']);
const exportFiltersSchema = z
  .object({
    occurredFrom: auditFilterDateTimeSchema.optional(),
    occurredTo: auditFilterDateTimeSchema.optional(),
    chatIds: z.array(z.string().trim().min(1).max(128)).optional(),
    topicId: z.string().trim().min(1).max(128).optional(),
    actorId: z.string().trim().min(1).max(128).optional(),
    eventTypes: z.array(z.string().trim().min(1).max(128)).optional(),
    categories: z.array(eventCategorySchema).optional(),
    moduleId: z.string().trim().min(1).max(128).optional(),
    source: z.string().trim().min(1).max(128).optional(),
    status: eventStatusSchema.optional(),
    subjectType: z.string().trim().min(1).max(128).optional(),
    subjectId: z.string().trim().min(1).max(256).optional(),
    correlationId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
const exportRequestSchema = z
  .object({
    format: exportFormatSchema.default('json'),
    filters: exportFiltersSchema.default({}),
    limit: z.number().int().positive().optional(),
  })
  .strict();

type ExportRequest = z.infer<typeof exportRequestSchema>;

export interface AuditExportApiDependencies {
  readonly db: DrizzleDatabase;
  readonly audit: AuditService;
}

export async function handleAuditExportRequest(
  method: string | undefined,
  url: URL,
  body: unknown,
  principal: BackendApiPrincipal,
  deps: AuditExportApiDependencies,
): Promise<ApiResponse | undefined> {
  if (method !== 'POST' || url.pathname !== '/api/v1/audit/exports') return undefined;
  if (!hasBackendApiPermission(principal, 'audit.exports.create')) return forbidden();

  const parsed = exportRequestSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.message);

  try {
    const result = await createAuditExport(deps.db, deps.audit, {
      scope: exportScope(principal),
      filters: toReadFilters(parsed.data),
      format: parsed.data.format,
      requestedBy: principal.actorId,
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });

    return {
      statusCode: 201,
      body: {
        item: {
          exportId: result.exportId,
          format: result.format,
          contentType: result.contentType,
          rowCount: result.rowCount,
          truncated: result.truncated,
          auditEventId: result.auditEventId,
          data: result.data,
        },
      },
    };
  } catch (error: unknown) {
    if (error instanceof AuditExportPolicyError) return forbidden();
    throw error;
  }
}

function exportScope(principal: BackendApiPrincipal): AuditEventsReadScope {
  return { systemAdmin: principal.systemAdmin, allowedChatIds: principal.allowedChatIds };
}

function toReadFilters(request: ExportRequest): AuditEventsReadFilters {
  const filters = request.filters;
  return {
    ...(filters.occurredFrom === undefined ? {} : { occurredFrom: filters.occurredFrom }),
    ...(filters.occurredTo === undefined ? {} : { occurredTo: filters.occurredTo }),
    ...(filters.chatIds === undefined ? {} : { chatIds: filters.chatIds }),
    ...(filters.topicId === undefined ? {} : { topicId: filters.topicId }),
    ...(filters.actorId === undefined ? {} : { actorId: filters.actorId }),
    ...(filters.eventTypes === undefined ? {} : { eventTypes: filters.eventTypes }),
    ...(filters.categories === undefined ? {} : { categories: filters.categories }),
    ...(filters.moduleId === undefined ? {} : { moduleId: filters.moduleId }),
    ...(filters.source === undefined ? {} : { source: filters.source }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.subjectType === undefined ? {} : { subjectType: filters.subjectType }),
    ...(filters.subjectId === undefined ? {} : { subjectId: filters.subjectId }),
    ...(filters.correlationId === undefined ? {} : { correlationId: filters.correlationId }),
  };
}
