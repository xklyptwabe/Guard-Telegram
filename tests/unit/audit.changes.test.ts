import { describe, expect, it } from 'vitest';

import type { AuditOperation } from '../../src/lib/audit/enums.js';
import { computeChanges, OPERATION_ABSENCE_RULES } from '../../src/lib/audit/changes.js';
import { notApplicable, notObserved, observed, redacted, unknownSnapshot, type Snapshot } from '../../src/lib/audit/snapshot.js';

interface Fields extends Record<string, unknown> {
  enabled: boolean;
  locale?: string;
  deletedAt?: string;
}

describe('computeChanges', () => {
  it('reports only fields that actually differ', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: false, locale: 'en' });
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true, locale: 'en' });

    const result = computeChanges('update', before, after);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.fields).toEqual({ enabled: { before: false, after: true } });
      expect(result.fields).not.toHaveProperty('locale');
    }
  });

  it('treats a not_applicable "before" as no prior fields on create, without fabricating {}', () => {
    const before: Snapshot<Partial<Fields>> = notApplicable();
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('create', before, after);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.fields).toEqual({ enabled: { before: undefined, after: true } });
    }
  });

  it('treats a not_applicable "after" as no remaining fields on delete', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true });
    const after: Snapshot<Partial<Fields>> = notApplicable();

    const result = computeChanges('delete', before, after);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.fields).toEqual({ enabled: { before: true, after: undefined } });
    }
  });

  it('reports noop as computed-but-empty when both sides are equal', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true });
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('noop', before, after);
    expect(result).toEqual({ status: 'computed', fields: {} });
  });

  it('is unavailable — never {} — when a snapshot is redacted', () => {
    const before: Snapshot<Partial<Fields>> = redacted();
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('update', before, after);
    expect(result).toEqual({ status: 'unavailable', reason: 'before_redacted' });
  });

  it('is unavailable when a snapshot was never observed', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true });
    const after: Snapshot<Partial<Fields>> = notObserved();

    const result = computeChanges('update', before, after);
    expect(result).toEqual({ status: 'unavailable', reason: 'after_not_observed' });
  });

  it('treats an unexpected not_applicable (e.g. before on update) as unavailable, not as empty', () => {
    const before: Snapshot<Partial<Fields>> = notApplicable();
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('update', before, after);
    expect(result).toEqual({ status: 'unavailable', reason: 'before_not_applicable' });
  });

  it('computes a normal diff for soft_delete — the row still exists on both sides', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true });
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true, deletedAt: '2026-08-01T00:00:00Z' });

    const result = computeChanges('soft_delete', before, after);
    expect(result).toEqual({
      status: 'computed',
      fields: { deletedAt: { before: undefined, after: '2026-08-01T00:00:00Z' } },
    });
  });

  it('unlike a hard delete, soft_delete does not accept a not_applicable "after"', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true });
    const after: Snapshot<Partial<Fields>> = notApplicable();

    const result = computeChanges('soft_delete', before, after);
    expect(result).toEqual({ status: 'unavailable', reason: 'after_not_applicable' });
  });

  it('treats a failed operation with no state on either side as an empty diff, not a fabricated deletion', () => {
    const before: Snapshot<Partial<Fields>> = notApplicable();
    const after: Snapshot<Partial<Fields>> = notApplicable();

    // e.g. a create that failed: nothing existed before, nothing exists after.
    const result = computeChanges('failed', before, after);
    expect(result).toEqual({ status: 'computed', fields: {} });
  });

  it('makes no absence assumption for an unknown operation — not_applicable is tolerated on either side', () => {
    const before: Snapshot<Partial<Fields>> = notApplicable();
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('unknown', before, after);
    expect(result).toEqual({ status: 'computed', fields: { enabled: { before: undefined, after: true } } });
  });

  it('is unavailable — never {} — when a snapshot status is genuinely unknown', () => {
    const before: Snapshot<Partial<Fields>> = unknownSnapshot();
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true });

    const result = computeChanges('update', before, after);
    expect(result).toEqual({ status: 'unavailable', reason: 'before_unknown' });
  });

  it('defines an explicit absence rule for every AuditOperation from the BOTS-7 spec', () => {
    const operations: readonly AuditOperation[] = ['create', 'update', 'delete', 'soft_delete', 'noop', 'failed', 'unknown'];
    for (const operation of operations) {
      expect(OPERATION_ABSENCE_RULES[operation]).toBeDefined();
    }
    expect(Object.keys(OPERATION_ABSENCE_RULES).sort()).toEqual([...operations].sort());
  });

  it('does not report an unchanged NaN field as changed (NaN !== NaN in plain JS equality)', () => {
    const before: Snapshot<Partial<Fields>> = observed({ enabled: true, locale: NaN as unknown as string });
    const after: Snapshot<Partial<Fields>> = observed({ enabled: true, locale: NaN as unknown as string });

    const result = computeChanges('update', before, after);
    expect(result).toEqual({ status: 'computed', fields: {} });
  });
});
