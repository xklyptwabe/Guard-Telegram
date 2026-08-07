import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const backendApiPermissionSchema = z.enum([
  'audit.events.read',
  'audit.policies.manage',
  'audit.exports.create',
]);

export type BackendApiPermission = z.infer<typeof backendApiPermissionSchema>;

export const backendApiPrincipalConfigSchema = z.object({
  token: z.string().min(16).max(512).regex(/^[A-Za-z0-9._~+/-]+=*$/),
  actorId: z.string().trim().min(1).max(128),
  permissions: z.array(backendApiPermissionSchema).default([]),
  allowedChatIds: z.array(z.string().trim().min(1).max(128)).default([]),
  systemAdmin: z.boolean().default(false),
});

export type BackendApiPrincipalConfig = z.infer<typeof backendApiPrincipalConfigSchema>;

export interface BackendApiPrincipal {
  readonly actorId: string;
  readonly permissions: readonly BackendApiPermission[];
  readonly allowedChatIds: readonly string[];
  readonly systemAdmin: boolean;
}

export function authenticateBackendApiPrincipal(
  authorizationHeader: string | readonly string[] | undefined,
  principals: readonly BackendApiPrincipalConfig[],
): BackendApiPrincipal | undefined {
  const token = bearerToken(authorizationHeader);
  if (token === undefined) return undefined;
  const matched = principals.find((principal) => constantTimeTokenEquals(token, principal.token));
  if (matched === undefined) return undefined;
  return {
    actorId: matched.actorId,
    permissions: matched.permissions,
    allowedChatIds: matched.allowedChatIds,
    systemAdmin: matched.systemAdmin,
  };
}

export function hasBackendApiPermission(
  principal: BackendApiPrincipal,
  permission: BackendApiPermission,
): boolean {
  return principal.permissions.includes(permission);
}

export function canAccessBackendApiChat(principal: BackendApiPrincipal, chatId: string): boolean {
  return principal.systemAdmin || principal.allowedChatIds.includes(chatId);
}

export function canAccessGlobalAudit(principal: BackendApiPrincipal): boolean {
  return principal.systemAdmin;
}

function bearerToken(authorizationHeader: string | readonly string[] | undefined): string | undefined {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorizationHeader);
  return match?.[1];
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
