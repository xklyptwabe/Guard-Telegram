import { MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';
import { recordMemberStatusChanged } from '../../lib/audit/memberAudit.js';
import type { AuditService } from '../../lib/auditService.js';
import type { Logger } from '../../lib/logger.js';

/**
 * BOTS-9: `member.status.changed` existed as BOTS-7 scaffolding with no
 * real Telegram update handler anywhere in the app. This module is that
 * handler — a `chat_member` update handler that records real join/leave/
 * promote/demote/ban/restrict transitions. Requires `chat_member` in
 * `TELEGRAM_ALLOWED_UPDATES` (see `src/config.ts`) or Telegram simply never
 * sends it.
 *
 * A dedicated module (rather than folding this into `moderation` or
 * `help`) because its event is `canBeDisabled: true` — a chat's admins
 * should be able to turn this observability off per chat, same as any
 * other module, unlike `bot.membership.changed` (see
 * `botMembershipAudit.ts`), which is always-on infrastructure.
 */
export function createMembershipAuditModule(audit: AuditService, logger: Logger): TelegramBotModule {
  return {
    id: MODULE_IDS.membershipAudit,
    name: 'Membership audit',
    description: 'Audits chat member status changes (join, leave, promote, demote, ban, restrict) as observed via real Telegram chat_member updates.',
    global: true,
    defaultEnabled: true,
    updateHandlers: [
      {
        id: 'membership-audit-chat-member',
        async handle(ctx): Promise<void> {
          await recordMemberStatusChanged(audit, logger, ctx);
        },
      },
    ],
  };
}
