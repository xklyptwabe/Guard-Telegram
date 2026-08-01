import type { AuditOperation } from './enums.js';
import { AuditSnapshotValidationError } from './errors.js';
import type { AuditEventName, AuditEventShapeMap } from './eventMap.js';
import { applyAllowlist, type AuditPolicyContext } from './masking.js';
import { computeChanges } from './changes.js';
import { auditEventRegistry, type AuditEventRegistry } from './registry.js';
import { mapSnapshot, observed, type Snapshot } from './snapshot.js';
import type { AuditEventDefinition, AuditRecord } from './types.js';

export interface RaiseAuditEventInput<Name extends AuditEventName> {
  readonly name: Name;
  readonly version: number;
  readonly operation: AuditOperation;
  readonly occurredAt?: string;
  readonly actorId?: string;
  readonly chatId?: string;
  /**
   * Raw, not-yet-validated "before" snapshot. Whatever produced this value
   * (a module, a Telegram update handler, a scheduled job) is responsible
   * for choosing the right non-observed status when it does not have real
   * data — never for inventing an empty object.
   */
  readonly before: Snapshot<unknown>;
  /**
   * Raw "after" snapshot. Per the BOTS-7 criteria this must reflect what was
   * *actually persisted* by the caller (e.g. a row read back after write, or
   * exactly the payload that was written) — never a raw in-memory domain
   * object the caller merely intends to persist.
   */
  readonly after: Snapshot<unknown>;
  readonly policy?: AuditPolicyContext;
}

/**
 * Turns a raw event occurrence into a safe {@link AuditRecord}. This is the
 * single choke point every audited event must pass through: registry lookup
 * (rejects unregistered events / unsupported versions), schema validation,
 * allowlist + masking, and change computation, always in that order — so
 * masking can never be accidentally skipped for one code path but not
 * another.
 */
export class AuditEventProcessor {
  public constructor(private readonly registry: AuditEventRegistry = auditEventRegistry) {}

  public process<Name extends AuditEventName>(
    input: RaiseAuditEventInput<Name>,
  ): AuditRecord<AuditEventShapeMap[Name]> {
    const definition = this.registry.requireSupportedVersion(input.name, input.version) as unknown as AuditEventDefinition<
      AuditEventShapeMap[Name]
    >;

    const policy: AuditPolicyContext = input.policy ?? { allowMessageTextLogging: false };

    const validatedBefore = this.validateSide(definition, 'before', input.before);
    const validatedAfter = this.validateSide(definition, 'after', input.after);

    const maskedBefore = mapSnapshot(validatedBefore, (data) => applyAllowlist(data, definition.allowlist, policy));
    const maskedAfter = mapSnapshot(validatedAfter, (data) => applyAllowlist(data, definition.allowlist, policy));

    const changes = computeChanges(input.operation, maskedBefore, maskedAfter);

    return {
      eventName: definition.name,
      eventVersion: input.version,
      category: definition.category,
      severity: definition.severity,
      siteVisible: definition.siteVisible,
      operation: input.operation,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      actorId: input.actorId,
      chatId: input.chatId,
      before: maskedBefore,
      after: maskedAfter,
      changes,
    };
  }

  private validateSide<T extends Record<string, unknown>>(
    definition: AuditEventDefinition<T>,
    side: 'before' | 'after',
    raw: Snapshot<unknown>,
  ): Snapshot<T> {
    // Non-observed statuses carry no data, so there is nothing to validate —
    // and, importantly, nothing to default to `{}` either.
    if (raw.status !== 'observed') return raw;

    const schema = definition.sparseSnapshotSchema ?? definition.snapshotSchema;
    const result = schema.safeParse(raw.data);
    if (!result.success) {
      throw new AuditSnapshotValidationError(definition.name, side, result.error.message);
    }
    return observed(result.data as T);
  }
}

/** Convenience singleton for call sites that don't need a custom registry (e.g. tests). */
export const auditEventProcessor = new AuditEventProcessor();
