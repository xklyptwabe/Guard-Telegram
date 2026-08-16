import type { TelegramBotModule } from '../core/contracts.js';
import type { AuditService } from '../lib/auditService.js';
import type { ChatSettingsService } from '../lib/chatSettings.js';
import type { Logger } from '../lib/logger.js';
import type { ModerationService } from '../lib/moderation/moderationService.js';
import { createChatSettingsModule } from './global/chatSettings.js';
import { helpModule } from './global/help.js';
import { createMembershipAuditModule } from './global/membershipAudit.js';
import { createMessageAuditModule } from './global/messageAudit.js';
import { moduleAdminModule } from './global/moduleAdmin.js';
import { exampleToolsModule } from './local/exampleTools.js';
import { createModerationModule } from './local/moderation.js';

export interface CreateModulesDeps {
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly chatSettings: ChatSettingsService;
  readonly moderation: ModerationService;
}

/**
 * BOTS-9: several modules now need real service instances (audit, the
 * moderation outbox, chat settings) rather than only what
 * `CommandExecutionContext` already provides, so the module list moved
 * from a static array to this factory — constructed once in `index.ts`
 * after those services exist. Nothing else in the codebase imports
 * `modules` directly (verified: only `src/index.ts` does), so this is a
 * safe, contained change.
 */
export function createModules(deps: CreateModulesDeps): readonly TelegramBotModule[] {
  return [
    helpModule,
    moduleAdminModule,
    exampleToolsModule,
    createChatSettingsModule(deps.chatSettings),
    createMembershipAuditModule(deps.audit, deps.logger),
    createMessageAuditModule(deps.audit, deps.logger),
    createModerationModule(deps.moderation),
  ];
}
