import { z } from 'zod';

import { COMMAND_NAMES, MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';

const emptyArgs = z.string().trim().max(0);

export const helpModule: TelegramBotModule = {
  id: MODULE_IDS.help,
  name: 'Help',
  description: 'Provides the command directory.',
  global: true,
  defaultEnabled: true,
  commands: [
    {
      id: 'help.show',
      name: COMMAND_NAMES.help,
      moduleId: MODULE_IDS.help,
      descriptionKey: 'commands.help',
      permission: 'none',
      cooldownMs: 500,
      argsSchema: emptyArgs,
      async execute(context): Promise<void> {
        const states = await context.registry.listStates(context.chatId);
        const enabledModules = new Set(states.filter((state) => state.enabled).map((state) => state.id));
        const commands = context.registry.modules
          .filter((module) => enabledModules.has(module.id))
          .flatMap((module) => module.commands ?? [])
          .map((command) => `/${command.name}`)
          .join('\n');
        await context.reply.send(context.ctx, `${context.t('help.title')}\n${commands}`);
      },
    },
  ],
};
