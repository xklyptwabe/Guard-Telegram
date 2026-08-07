import { describe, expect, it } from 'vitest';

import {
  authenticateBackendApiPrincipal,
  canAccessBackendApiChat,
  canAccessGlobalAudit,
  hasBackendApiPermission,
  type BackendApiPrincipalConfig,
} from '../../src/api/access.js';

const principals: readonly BackendApiPrincipalConfig[] = [
  {
    token: 'read-token-123456',
    actorId: 'reader',
    permissions: ['audit.events.read'],
    allowedChatIds: ['chat-1'],
    systemAdmin: false,
  },
  {
    token: 'admin-token-123456',
    actorId: 'system-admin',
    permissions: ['audit.events.read', 'audit.policies.manage', 'audit.exports.create'],
    allowedChatIds: [],
    systemAdmin: true,
  },
];

describe('backend API access control', () => {
  it('authenticates a Bearer token without exposing the token on the principal', () => {
    const principal = authenticateBackendApiPrincipal('Bearer read-token-123456', principals);

    expect(principal).toEqual({
      actorId: 'reader',
      permissions: ['audit.events.read'],
      allowedChatIds: ['chat-1'],
      systemAdmin: false,
    });
    expect(principal).not.toHaveProperty('token');
  });

  it('rejects missing, malformed, and unknown authorization headers', () => {
    expect(authenticateBackendApiPrincipal(undefined, principals)).toBeUndefined();
    expect(authenticateBackendApiPrincipal('Basic read-token-123456', principals)).toBeUndefined();
    expect(authenticateBackendApiPrincipal('Bearer unknown-token-123456', principals)).toBeUndefined();
  });

  it('keeps read, policy-management, and export permissions separate', () => {
    const principal = authenticateBackendApiPrincipal('Bearer read-token-123456', principals);
    expect(principal).toBeDefined();
    if (principal === undefined) return;

    expect(hasBackendApiPermission(principal, 'audit.events.read')).toBe(true);
    expect(hasBackendApiPermission(principal, 'audit.policies.manage')).toBe(false);
    expect(hasBackendApiPermission(principal, 'audit.exports.create')).toBe(false);
  });

  it('limits non-system principals to explicitly allowed chats', () => {
    const principal = authenticateBackendApiPrincipal('Bearer read-token-123456', principals);
    expect(principal).toBeDefined();
    if (principal === undefined) return;

    expect(canAccessBackendApiChat(principal, 'chat-1')).toBe(true);
    expect(canAccessBackendApiChat(principal, 'chat-2')).toBe(false);
    expect(canAccessGlobalAudit(principal)).toBe(false);
  });

  it('allows global audit access only for system administrators', () => {
    const principal = authenticateBackendApiPrincipal('Bearer admin-token-123456', principals);
    expect(principal).toBeDefined();
    if (principal === undefined) return;

    expect(canAccessBackendApiChat(principal, 'chat-2')).toBe(true);
    expect(canAccessGlobalAudit(principal)).toBe(true);
  });
});
