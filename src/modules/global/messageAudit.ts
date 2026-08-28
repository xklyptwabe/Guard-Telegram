import { MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';
import { recordMessageEdited, recordMessageObserved } from '../../lib/audit/messageAudit.js';
import type { AuditService } from '../../lib/auditService.js';
import type { Logger } from '../../lib/logger.js';

/**
 * BOTS-9: `message.edited` existed as BOTS-7 scaffolding with no real
 * Telegram update handler anywhere in the app. This module is that
 * handler for both `edited_message` and `edited_channel_post`. Actor fields
 * are omitted when Telegram does not expose `from`; message state is still
 * recorded without fabricating an identity. Ordinary `message` and
 * `channel_post` updates also refresh the last policy-allowed snapshot.
 * Requires all four update types in `TELEGRAM_ALLOWED_UPDATES` (see
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
    description: 'Audits message edits observed via real Telegram edited_message and edited_channel_post updates. Deletions by anyone other than this bot are not observable via the Bot API and are not audited — see src/lib/audit/messageAudit.ts.',
    global: true,
    defaultEnabled: true,
    updateHandlers: [
      {
        id: 'message-audit-observed-message',
        async handle(ctx): Promise<void> {
          await recordMessageObserved(audit, logger, ctx);
        },
      },
      {
        id: 'message-audit-edited-message',
        async handle(ctx): Promise<void> {
          await recordMessageEdited(audit, logger, ctx);
        },
      },
    ],
  };
}
