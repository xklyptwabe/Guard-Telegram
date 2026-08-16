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
  /(^|_)(password|passwd|secret|token|api_?key|auth(orization)?|headers?|connection_?string|conn_?str|dsn|webhook_?secret|raw_?update|callback_?(data|query)|file_?(id|path|url)|cookie)(_|$)/;

/**
 * BOTS-9 review finding (BLOCKER-4): key-based stripping alone misses
 * secrets that show up inside the *value* of an otherwise-legitimate
 * field — a moderation `reason` is free text an admin typed and is
 * correctly allowlisted (that's the whole point of the field), but
 * nothing stops someone from pasting a token into it. Likewise an
 * unstructured `Error.message` (e.g. from a network/timeout failure in
 * `pendingOperationsOutbox.ts`) has no key to match at all. These patterns
 * are deliberately narrow, high-confidence shapes — not a general secret
 * detector — to keep false positives on ordinary admin-written text rare.
 */
const SECRET_LIKE_VALUE_PATTERNS: readonly RegExp[] = [
  // scheme://user:password@host — credentials embedded in a URL or DSN
  // (Postgres, AMQP, MongoDB, etc.), the exact shape a raw connection
  // error's message can leak.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S*/gi,
  // "Bearer <token>" / "Authorization: <token>"-style credentials that
  // ended up in free text rather than a header field.
  /\b(?:Bearer|Token|ApiKey|Api-Key)\s+[A-Za-z0-9\-_.]{12,}/gi,
  // JWT-shaped three-part base64url strings.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  // Common vendor-specific API key prefixes (OpenAI-style sk-/pk-, GitHub
  // ghp_, Slack xox*, AWS AKIA...).
  /\b(?:sk|pk)-[A-Za-z0-9]{16,}\b/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function redactSecretLikeSubstrings(value: string): string {
  let result = value;
  for (const pattern of SECRET_LIKE_VALUE_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

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
  if (typeof value === 'string') {
    return redactSecretLikeSubstrings(value) as unknown as T;
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
