import { z } from 'zod';

import { COMMAND_NAMES, MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';
import type { ChatSettingsService } from '../../lib/chatSettings.js';

const setLocaleArgs = z.string().trim();
const SUPPORTED_LOCALES = new Set(['ru', 'en']);

/**
 * BOTS-9: `chat.settings.changed` existed as BOTS-7 scaffolding with no
 * real trigger anywhere in the app. `/setlocale` is that trigger — a small,
 * genuinely useful admin command, not a placeholder built only to exercise
 * the audit pipeline.
 */
export function createChatSettingsModule(chatSettings: ChatSettingsService): TelegramBotModule {
  return {
    id: MODULE_IDS.chatSettings,
    name: 'Chat settings',
    description: 'Per-chat settings (currently: locale).',
    global: true,
    defaultEnabled: true,
    commands: [
      {
        id: 'chat-settings.set-locale',
        name: COMMAND_NAMES.setLocale,
        moduleId: MODULE_IDS.chatSettings,
        descriptionKey: 'commands.setlocale',
        permission: 'chat_admin',
        cooldownMs: 1000,
        argsSchema: setLocaleArgs,
        async execute(context, args): Promise<void> {
          const locale = setLocaleArgs.parse(args).toLowerCase();
          if (!SUPPORTED_LOCALES.has(locale)) {
            await context.reply.send(context.ctx, context.t('common.invalidArguments'));
            return;
          }
          await chatSettings.setLocale(context.chatId, locale, context.userId);
          await context.reply.send(context.ctx, context.t('chatSettings.changed', { locale }));
        },
      },
    ],
  };
}
