import { describe, expect, it } from 'vitest';

import { AUDIT_EVENT_DEFINITIONS } from '../../src/lib/audit/definitions.js';
import { AUDIT_EVENT_NAMES } from '../../src/lib/audit/eventMap.js';
import { UnregisteredAuditEventError, UnsupportedAuditEventVersionError } from '../../src/lib/audit/errors.js';
import { AuditEventRegistry, auditEventRegistry } from '../../src/lib/audit/registry.js';
import type { AuditEventDefinition } from '../../src/lib/audit/types.js';

describe('AuditEventRegistry', () => {
  it('has every event from the BOTS-7 spec registered', () => {
    for (const name of AUDIT_EVENT_NAMES) {
      expect(auditEventRegistry.has(name)).toBe(true);
    }
    expect(auditEventRegistry.list()).toHaveLength(AUDIT_EVENT_NAMES.length);
  });

  it('rejects an unregistered event name', () => {
    expect(() => auditEventRegistry.requireByName('totally.unknown.event')).toThrow(UnregisteredAuditEventError);
  });

  it('rejects an unsupported version for a known event', () => {
    expect(() => auditEventRegistry.requireSupportedVersion('module.state.changed', 99)).toThrow(
      UnsupportedAuditEventVersionError,
    );
  });

  it('accepts a supported version for a known event', () => {
    expect(() => auditEventRegistry.requireSupportedVersion('module.state.changed', 1)).not.toThrow();
  });

  it('refuses to construct with duplicate event names', () => {
    const definition = AUDIT_EVENT_DEFINITIONS['module.state.changed'] as unknown as AuditEventDefinition<
      Record<string, unknown>
    >;
    expect(() => new AuditEventRegistry([definition, definition])).toThrow(/Duplicate audit event registration/);
  });

  it('every definition supports at least its own current version', () => {
    for (const definition of Object.values(AUDIT_EVENT_DEFINITIONS)) {
      expect(definition.supportedVersions).toContain(definition.version);
    }
  });
});
