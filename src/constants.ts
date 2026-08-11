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
 * `docs/modules/0009-external-operation-outbox.md`.
 */
export const PENDING_OPERATION_MAX_ATTEMPTS = 5;
export const PENDING_OPERATION_RETRY_BASE_DELAY_MS = 2000;
/** How long a single Telegram API call may take before we give up waiting for a confirmed response and record `unknown` (not `failed` — we genuinely don't know what happened). */
export const PENDING_OPERATION_CALL_TIMEOUT_MS = 10000;
