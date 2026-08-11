import { MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';
import { recordMessageEdited } from '../../lib/audit/messageAudit.js';
import type { AuditService } from '../../lib/auditService.js';
import type { Logger } from '../../lib/logger.js';

/**
 * BOTS-9: `message.edited` existed as BOTS-7 scaffolding with no real
 * Telegram update handler anywhere in the app. This module is that
 * handler — an `edited_message`/`edited_channel_post` update handler.
 * Requires `edited_message` in `TELEGRAM_ALLOWED_UPDATES` (see
 * `src/config.ts`).
 *
 * There is deliberately no `message.deleted` handler here. The Telegram
 * Bot API has no update for a message someone else deleted — see
 * `src/lib/audit/messageAudit.ts`'s module doc comment. The only deletions
 * this codebase ever audits are the bot's own, driven by the `moderation`
 * module's `/delmsg` command.
 */
export function createMessageAuditModule(audit: AuditService, logger: Logger): TelegramBotModule {
  return {
    id: MODULE_IDS.messageAudit,
    name: 'Message audit',
    description: 'Audits message edits as observed via real Telegram edited_message updates. Deletions by anyone other than this bot are not observable via the Bot API and are not audited — see docs/modules/0009-message-deletion-limits.md.',
    global: true,
    defaultEnabled: true,
    updateHandlers: [
      {
        id: 'message-audit-edited-message',
        async handle(ctx): Promise<void> {
          await recordMessageEdited(audit, logger, ctx);
        },
      },
    ],
  };
}
