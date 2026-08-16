export const SERVICE_NAME = 'telegram-bot';
export const PROCESSED_UPDATE_RETENTION_DAYS = 7;
export const CALLBACK_VERSION = 'v1';

export const MODULE_IDS = {
  help: 'help',
  moduleAdmin: 'module-admin',
  chatSettings: 'chat-settings',
  membershipAudit: 'membership-audit',
  messageAudit: 'message-audit',
  moderation: 'moderation',
} as const;

export const COMMAND_NAMES = {
  help: 'help',
  modules: 'modules',
  moduleEnable: 'module_enable',
  moduleDisable: 'module_disable',
  setLocale: 'setlocale',
  ban: 'ban',
  unban: 'unban',
  restrict: 'restrict',
  unrestrict: 'unrestrict',
  kick: 'kick',
} as const;

/**
 * BOTS-9: how long the write-ahead outbox (`core.pending_operations`) keeps
 * retrying a Telegram API call it hasn't received a confirmed response for,
 * before it is left at `unknown` for an operator to look at. See
 * `docs/modules/0010-external-operation-outbox.md`.
 */
export const PENDING_OPERATION_MAX_ATTEMPTS = 5;
export const PENDING_OPERATION_RETRY_BASE_DELAY_MS = 2000;
/** How long a single Telegram API call may take before we give up waiting for a confirmed response and record `unknown` (not `failed` — we genuinely don't know what happened). */
export const PENDING_OPERATION_CALL_TIMEOUT_MS = 10000;
/**
 * BOTS-9 review fix (BLOCKER-2): how long a worker's claim on a row is
 * valid before another worker may reclaim it. Deliberately several times
 * `PENDING_OPERATION_CALL_TIMEOUT_MS` — a healthy worker always finishes
 * (or at least hits its own internal timeout and releases the row) long
 * before this expires; only a worker that has itself crashed, hung, or
 * lost its process entirely should ever have its claim stolen.
 */
export const PENDING_OPERATION_LEASE_DURATION_MS = 45_000;
/** How often the persistent outbox worker polls for due work while the process stays up — not just once at bootstrap. */
export const PENDING_OPERATION_WORKER_POLL_INTERVAL_MS = 5_000;

/**
 * BOTS-9 review finding (BLOCKER-5): the Telegram-update inbox
 * (`core.processed_updates`) state machine. A row is only a dedup marker
 * once `completed`; `failed`/`received`/expired-`processing` rows are
 * reprocessed when Telegram redelivers the update. The raw update payload
 * is never stored (BLOCKER-4), so there is no background inbox worker —
 * redelivery itself is the retry driver, and these bounds only cap how
 * many times a single update_id may be reprocessed.
 */
export const INBOX_MAX_ATTEMPTS = 5;
export const INBOX_RETRY_BASE_DELAY_MS = 2000;
/**
 * How long an in-flight `processing` claim is honored before a redelivered
 * update may steal it — a healthy handler chain finishes in milliseconds;
 * only a crashed/hung worker leaves an expired lease behind.
 */
export const INBOX_LEASE_DURATION_MS = 45_000;
