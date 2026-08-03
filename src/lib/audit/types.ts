import type { ZodType, ZodTypeAny } from 'zod';

import type { AuditOperation, EventCategory, EventSeverity } from './enums.js';
import type { AllowlistField } from './masking.js';
import type { Snapshot } from './snapshot.js';
import type { ChangeSet } from './changes.js';

/**
 * The full, static description of one event type. This is the "single
 * source of truth" the BOTS-7 spec asks for: version, category, snapshot
 * schema, allowlist, severity, site visibility and whether the event can be
 * turned off all live in one place, next to each other, so a reviewer can
 * audit an event's data-safety story in one read.
 */
export interface AuditEventDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  /** Current schema version this codebase produces/expects. */
  readonly version: number;
  /** All versions this registry is able to validate (including `version`). */
  readonly supportedVersions: readonly number[];
  readonly category: EventCategory;
  readonly severity: EventSeverity;
  /** Whether this event may ever be surfaced on a public/site-facing audit log. */
  readonly siteVisible: boolean;
  /** Whether chat/module admins may turn logging of this event off. Safety-critical events cannot. */
  readonly canBeDisabled: boolean;
  readonly snapshotSchema: ZodType<T>;
  /**
   * Fields that are ever allowed to reach the database, evaluated in order.
   * This is intersected with (not a replacement for) the global forbidden-key
   * scan in `masking.ts`.
   */
  readonly allowlist: readonly AllowlistField<T>[];
  /**
   * When present, before/after are validated against this schema instead of
   * `snapshotSchema`, and a snapshot may legitimately carry only some of the
   * entity's fields. Used for events that are only ever observed as a delta
   * against unknown surrounding state (currently `module.state.changed`: we
   * know a module was toggled, not the full resolved module configuration
   * for the chat). Declared explicitly per event (rather than derived via a
   * generic runtime `.partial()`) so it works uniformly even for schemas
   * that are not `ZodObject`s.
   */
  readonly sparseSnapshotSchema?: ZodTypeAny;
}

/**
 * The fully processed, safe-to-persist result for one occurrence of an
 * event. This is what an `AuditEventWriter` implementation would accept —
 * the registry's whole job ends at producing this value.
 */
export interface AuditRecord<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly category: EventCategory;
  readonly severity: EventSeverity;
  readonly siteVisible: boolean;
  readonly operation: AuditOperation;
  readonly occurredAt: string;
  readonly actorId: string | undefined;
  readonly chatId: string | undefined;
  /** Masked, allowlisted "before" snapshot — never raw domain data. */
  readonly before: Snapshot<Partial<T>>;
  /** Masked, allowlisted "after" snapshot, built only from persisted state. */
  readonly after: Snapshot<Partial<T>>;
  readonly changes: ChangeSet<T>;
}

/**
 * Minimal "just persist this" contract — BOTS-7 only depends on this
 * interface, no implementation lives here. Anything producing
 * `AuditRecord`s (see `eventProcessor.ts`) can take one via constructor
 * injection so a real implementation can be swapped in without touching
 * the registry/validation/masking code.
 *
 * Deliberately named *not* `AuditService`: BOTS-6's real, transactional
 * service (`src/lib/auditService.ts`, `AuditService.recordEntityChange`)
 * is a different, richer contract — identity is tenantId/subjectType/
 * subjectId, not chatId, and persistence happens inside a caller-supplied
 * `mutate` alongside the business write. This interface predates that
 * being confirmed and was originally also called `AuditService`, which
 * read as two incompatible implementations of "the same" thing. Kept here
 * only as a narrow, swappable seam for simple/log-like events; entity-like
 * events should go through BOTS-6's `recordEntityChange` directly (see
 * `serviceAdapter.ts`), not through this interface.
 */
export interface AuditEventWriter {
  record(entry: AuditRecord): Promise<void>;
}
