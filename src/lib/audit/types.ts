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
 * event. This is what a real `AuditService` implementation (task 1) would
 * accept — the registry's whole job ends at producing this value.
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
 * Contract for task 1's AuditService. BOTS-7 only depends on this interface
 * — no implementation lives here. Anything producing `AuditRecord`s (see
 * `service.ts`) should take an `AuditService` via constructor injection so
 * the real implementation can be swapped in later without touching the
 * registry/validation/masking code.
 */
export interface AuditService {
  record(entry: AuditRecord): Promise<void>;
}
