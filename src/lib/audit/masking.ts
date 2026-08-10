/**
 * Runtime policy passed in by the caller for a single event occurrence.
 * This is intentionally tiny: it only carries the knobs that the *masking*
 * layer needs to make a per-field decision. Everything else (whether the
 * module/audit feature itself is enabled, retention, etc.) belongs to the
 * future AuditService, not to the registry.
 */
export interface AuditPolicyContext {
  /** Whether raw/edited message text may be persisted for this chat. */
  readonly allowMessageTextLogging: boolean;
  /** Optional runtime allowlist; it narrows the event definition allowlist. */
  readonly allowlist?: readonly string[];
  /** Optional runtime masking list applied after the field is allowed. */
  readonly masking?: readonly string[];
}

export const AUDIT_OPERATIONAL_METADATA_ALLOWLIST = [
  'source',
  'moduleId',
  'operation',
  'reason',
  'auditPolicy',
  'truncated',
] as const;

const DEFAULT_POLICY: AuditPolicyContext = { allowMessageTextLogging: false };

/**
 * A single allowlist entry. Most fields are unconditionally allowed; some
 * (currently only message text) are only allowed when the runtime policy
 * says so. Keeping the condition on the allowlist entry (rather than on the
 * schema) means the schema stays a pure "shape" description while the
 * allowlist stays the single place that decides what is ever safe to write.
 */
export type AllowlistField<T> =
  | keyof T
  | {
      readonly field: keyof T;
      readonly when: (policy: AuditPolicyContext) => boolean;
    };

/**
 * Defense-in-depth: even if a field was mistakenly added to an event's
 * allowlist, or a snapshot schema is loosely typed (`Record<string, unknown>`
 * nested blobs, etc.), any key matching these patterns is stripped before the
 * record ever reaches the database. This list mirrors the hard "never store"
 * requirement from the BOTS-7 spec and is intentionally broader than any
 * single event's allowlist.
 */
const FORBIDDEN_KEY_PATTERN =
  /(^|_)(password|passwd|secret|token|api_?key|auth(orization)?|headers?|connection_?string|conn_?str|dsn|webhook_?secret|raw_?update|callback_?(data|query|payload)|files?|file_?(id|path|url)|cookie)(_|$)/;

/**
 * Normalizes camelCase, snake_case and kebab-case alike to `snake_case`
 * before matching. Field names in this codebase are camelCase
 * (`webhookSecret`, `connectionString`, `rawUpdate`, ...), so matching only
 * on pre-existing `_`/`-` boundaries would silently miss all of them —
 * normalizing first is what makes the pattern actually apply here.
 */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERN.test(normalizeKey(key));
}

/**
 * Recursively strips any key matching {@link FORBIDDEN_KEY_PATTERN} from a
 * plain-data value (objects/arrays only — this never needs to walk class
 * instances, DB rows are always plain JSON by the time they get here).
 */
export function stripForbidden<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => stripForbidden(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) continue;
      result[key] = stripForbidden(nested);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Projects `data` down to only the fields present in `allowlist`, evaluating
 * conditional fields against `policy`, and then runs the result through
 * {@link stripForbidden} as a second, independent layer. This function is the
 * *only* sanctioned path from "validated snapshot" to "thing that may be
 * persisted" — the registry never persists an unmasked snapshot.
 */
export function applyAllowlist<T extends Record<string, unknown>>(
  data: T,
  allowlist: readonly AllowlistField<T>[],
  policy: AuditPolicyContext = DEFAULT_POLICY,
): Partial<T> {
  const projected: Partial<T> = {};
  const runtimeAllowlist = policy.allowlist === undefined ? undefined : new Set(policy.allowlist);
  const runtimeMasking = new Set(policy.masking ?? []);
  for (const entry of allowlist) {
    const field = typeof entry === 'object' ? entry.field : entry;
    const allowed = typeof entry === 'object' ? entry.when(policy) : true;
    if (!allowed) continue;
    if (runtimeAllowlist !== undefined && !runtimeAllowlist.has(String(field))) continue;
    if (!(field in data)) continue;
    projected[field] = (runtimeMasking.has(String(field)) ? '[redacted]' : data[field]) as T[typeof field];
  }
  return stripForbidden(projected);
}
