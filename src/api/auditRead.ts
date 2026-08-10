import { z } from 'zod';

import type { DrizzleDatabase } from '../db/client.js';
import type { EventCategory } from '../lib/audit/enums.js';
import { resolveEffectiveAuditPolicy, type EffectiveAuditPolicy } from '../lib/audit/policyResolution.js';
import type { AuditPolicyResolutionTarget } from '../lib/audit/policyPriority.js';
import { auditEventRegistry } from '../lib/audit/registry.js';
import {
  AuditEventsCursorError,
  listAuditEventTypes,
  getAuditEventById,
  listAuditEvents,
  listAuditPolicies,
  type AuditEventReadRow,
  type AuditEventTypeReadRow,
  type AuditEventsReadFilters,
  type AuditEventsReadScope,
  type AuditPolicyReadRow,
} from '../lib/audit/eventReadRepository.js';
import type { BackendApiPrincipal } from './access.js';
import { canAccessBackendApiChat, hasBackendApiPermission } from './access.js';
import { auditFilterDateTimeSchema, auditLimitSchema } from './auditFilterValidation.js';
import { badRequest, forbidden, notFound, type ApiResponse } from './responses.js';

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
const uuidPathSegmentSchema = z.string().uuid();
const policyResolutionTargetSchema = z.object({
  chatId: z.string().trim().min(1).max(128).optional(),
  eventType: z.string().trim().min(1).max(128),
  eventVersion: z.string().regex(/^v\d+$/),
  moduleId: z.string().trim().min(1).max(128).optional(),
});

export interface AuditReadApiDependencies {
  readonly db: DrizzleDatabase;
}

export async function handleAuditReadRequest(
  method: string | undefined,
  url: URL,
  principal: BackendApiPrincipal,
  deps: AuditReadApiDependencies,
): Promise<ApiResponse | undefined> {
  if (method !== 'GET') return undefined;
  if (!url.pathname.startsWith('/api/v1/audit/')) return undefined;
  if (!hasBackendApiPermission(principal, 'audit.events.read')) {
    return forbidden();
  }

  const scope = readScope(principal);
  if (url.pathname === '/api/v1/audit/events') {
    return listEvents(url, deps, scope);
  }
  if (url.pathname === '/api/v1/audit/event-types') {
    return { statusCode: 200, body: { items: serializeEventTypes(await listAuditEventTypes(deps.db)) } };
  }
  if (url.pathname === '/api/v1/audit/policies') {
    return listPolicies(url, principal, deps, scope);
  }

  const eventId = matchEventById(url.pathname);
  if (eventId !== undefined) {
    return getEvent(eventId, deps, scope);
  }
  return undefined;
}

async function listPolicies(
  url: URL,
  principal: BackendApiPrincipal,
  deps: AuditReadApiDependencies,
  scope: AuditEventsReadScope,
): Promise<ApiResponse> {
  const parsedTarget = parsePolicyResolutionTarget(url.searchParams);
  if (!parsedTarget.success) return badRequest(parsedTarget.error.message);
  const target = parsedTarget.target;
  if (
    target !== undefined &&
    !principal.systemAdmin &&
    (target.chatId === undefined || !canAccessBackendApiChat(principal, target.chatId))
  ) {
    return forbidden();
  }

  const items = serializePolicies(await listAuditPolicies(deps.db, scope));
  if (target === undefined) return { statusCode: 200, body: { items } };

  const effective = await resolveEffectiveAuditPolicy(deps.db, target);
  return {
    statusCode: 200,
    body: {
      items,
      effectivePolicy: serializeEffectivePolicy(target, effective),
    },
  };
}

async function listEvents(
  url: URL,
  deps: AuditReadApiDependencies,
  scope: AuditEventsReadScope,
): Promise<ApiResponse> {
  const query = parseEventListQuery(url.searchParams);
  if (!query.success) return badRequest(query.error.message);

  try {
    const page = await listAuditEvents(deps.db, { scope, siteVisibleOnly: true, ...query.data });
    return {
      statusCode: 200,
      body: {
        items: page.items.map(serializeEvent),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    };
  } catch (error: unknown) {
    if (error instanceof AuditEventsCursorError) return badRequest(error.message);
    throw error;
  }
}

async function getEvent(
  id: string,
  deps: AuditReadApiDependencies,
  scope: AuditEventsReadScope,
): Promise<ApiResponse> {
  const event = await getAuditEventById(deps.db, { id, scope, siteVisibleOnly: true });
  if (event === undefined) return notFound();
  return { statusCode: 200, body: { item: serializeEvent(event) } };
}

function parseEventListQuery(searchParams: URLSearchParams):
  | { readonly success: true; readonly data: { readonly filters: AuditEventsReadFilters; readonly limit?: number; readonly cursor?: string } }
  | { readonly success: false; readonly error: Error } {
  try {
    const occurredFrom = dateParam(searchParams, 'occurredFrom');
    const occurredTo = dateParam(searchParams, 'occurredTo');
    const chatIds = stringList(searchParams, 'chatId');
    const topicId = stringParam(searchParams, 'topicId');
    const actorId = stringParam(searchParams, 'actorId');
    const eventTypes = stringList(searchParams, 'eventType');
    const categories = categoryList(searchParams);
    const moduleId = stringParam(searchParams, 'moduleId');
    const source = stringParam(searchParams, 'source');
    const status = eventStatus(searchParams);
    const subjectType = stringParam(searchParams, 'subjectType');
    const subjectId = stringParam(searchParams, 'subjectId');
    const correlationId = stringParam(searchParams, 'correlationId');
    const limit = positiveIntParam(searchParams, 'limit');
    const cursor = stringParam(searchParams, 'cursor');

    const filters: AuditEventsReadFilters = {
      ...(occurredFrom === undefined ? {} : { occurredFrom }),
      ...(occurredTo === undefined ? {} : { occurredTo }),
      ...(chatIds.length === 0 ? {} : { chatIds }),
      ...(topicId === undefined ? {} : { topicId }),
      ...(actorId === undefined ? {} : { actorId }),
      ...(eventTypes.length === 0 ? {} : { eventTypes }),
      ...(categories.length === 0 ? {} : { categories }),
      ...(moduleId === undefined ? {} : { moduleId }),
      ...(source === undefined ? {} : { source }),
      ...(status === undefined ? {} : { status }),
      ...(subjectType === undefined ? {} : { subjectType }),
      ...(subjectId === undefined ? {} : { subjectId }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
    return {
      success: true,
      data: {
        filters,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function matchEventById(pathname: string): string | undefined {
  const prefix = '/api/v1/audit/events/';
  if (!pathname.startsWith(prefix)) return undefined;
  const rawId = pathname.slice(prefix.length);
  const parsed = uuidPathSegmentSchema.safeParse(rawId);
  return parsed.success ? parsed.data : undefined;
}

function readScope(principal: BackendApiPrincipal): AuditEventsReadScope {
  return { systemAdmin: principal.systemAdmin, allowedChatIds: principal.allowedChatIds };
}

function parsePolicyResolutionTarget(searchParams: URLSearchParams):
  | { readonly success: true; readonly target?: AuditPolicyResolutionTarget }
  | { readonly success: false; readonly error: Error } {
  const targetKeys = ['chatId', 'eventType', 'eventVersion', 'moduleId'] as const;
  if (!targetKeys.some((key) => searchParams.has(key))) return { success: true };

  const parsed = policyResolutionTargetSchema.safeParse({
    chatId: stringParam(searchParams, 'chatId'),
    eventType: stringParam(searchParams, 'eventType'),
    eventVersion: stringParam(searchParams, 'eventVersion'),
    moduleId: stringParam(searchParams, 'moduleId'),
  });
  if (!parsed.success) return { success: false, error: new Error(parsed.error.message) };

  const version = Number(parsed.data.eventVersion.slice(1));
  try {
    auditEventRegistry.requireSupportedVersion(parsed.data.eventType, version);
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
  return {
    success: true,
    target: {
      ...(parsed.data.chatId === undefined ? {} : { chatId: parsed.data.chatId }),
      eventType: parsed.data.eventType,
      eventVersion: parsed.data.eventVersion,
      ...(parsed.data.moduleId === undefined ? {} : { moduleId: parsed.data.moduleId }),
    },
  };
}

function dateParam(searchParams: URLSearchParams, key: string): Date | undefined {
  const value = stringParam(searchParams, key);
  if (value === undefined) return undefined;
  return auditFilterDateTimeSchema.parse(value);
}

function positiveIntParam(searchParams: URLSearchParams, key: string): number | undefined {
  const value = stringParam(searchParams, key);
  if (value === undefined) return undefined;
  return auditLimitSchema.parse(Number(value));
}

function eventStatus(searchParams: URLSearchParams) {
  const value = stringParam(searchParams, 'status');
  if (value === undefined) return undefined;
  return eventStatusSchema.parse(value);
}

function categoryList(searchParams: URLSearchParams): readonly EventCategory[] {
  return stringList(searchParams, 'category').map((value) => eventCategorySchema.parse(value));
}

function stringParam(searchParams: URLSearchParams, key: string): string | undefined {
  const value = searchParams.get(key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function stringList(searchParams: URLSearchParams, key: string): readonly string[] {
  return searchParams
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function serializeEvent(row: AuditEventReadRow): Record<string, unknown> {
  return {
    ...row,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

function serializeEventTypes(rows: readonly AuditEventTypeReadRow[]): readonly Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function serializePolicies(rows: readonly AuditPolicyReadRow[]): readonly Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function serializeEffectivePolicy(
  target: AuditPolicyResolutionTarget,
  effective: EffectiveAuditPolicy,
): Record<string, unknown> {
  return {
    target: {
      ...(target.chatId === undefined ? {} : { chatId: target.chatId }),
      eventType: target.eventType,
      eventVersion: target.eventVersion,
      ...(target.moduleId === undefined ? {} : { moduleId: target.moduleId }),
    },
    values: effective.values,
    sources: effective.sources,
  };
}
