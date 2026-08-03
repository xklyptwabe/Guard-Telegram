import { z } from 'zod';

import { COMMAND_NAMES, MODULE_IDS } from '../../constants.js';
import type { TelegramBotModule } from '../../core/contracts.js';

const moduleIdSchema = z.object({ moduleId: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64) });
const moduleArgument = z.string().trim().transform((value) => ({ moduleId: value })).pipe(moduleIdSchema);

function moduleStateLabel(context: Parameters<NonNullable<TelegramBotModule['commands']>[number]['execute']>[0], enabled: boolean): string {
  return context.t(enabled ? 'modules.enabled' : 'modules.disabled');
}

export const moduleAdminModule: TelegramBotModule = {
  id: MODULE_IDS.moduleAdmin,
  name: 'Module administration',
  description: 'Lets chat administrators opt modules in or out for their chat.',
  global: true,
  defaultEnabled: true,
  commands: [
    {
      id: 'modules.list',
      name: COMMAND_NAMES.modules,
      moduleId: MODULE_IDS.moduleAdmin,
      descriptionKey: 'commands.modules',
      permission: 'chat_admin',
      cooldownMs: 500,
      argsSchema: z.string().trim().max(0),
      async execute(context): Promise<void> {
        const states = await context.registry.listStates(context.chatId);
        const lines = states.map((state) => `• ${state.id}: ${moduleStateLabel(context, state.enabled)}`);
        await context.reply.send(context.ctx, `${context.t('modules.title')}\n${lines.join('\n')}`);
      },
    },
    {
      id: 'modules.enable',
      name: COMMAND_NAMES.moduleEnable,
      moduleId: MODULE_IDS.moduleAdmin,
      descriptionKey: 'commands.module_enable',
      permission: 'chat_admin',
      cooldownMs: 500,
      argsSchema: moduleArgument,
      async execute(context, args): Promise<void> {
        const { moduleId } = moduleIdSchema.parse(args);
        if (!context.registry.get(moduleId)) {
          await context.reply.send(context.ctx, context.t('modules.unknown', { moduleId }));
          return;
        }
        await context.registry.setEnabled(context.chatId, moduleId, true, context.userId);
        await context.reply.send(context.ctx, context.t('modules.changed', { moduleId, state: moduleStateLabel(context, true) }));
      },
    },
    {
      id: 'modules.disable',
      name: COMMAND_NAMES.moduleDisable,
      moduleId: MODULE_IDS.moduleAdmin,
      descriptionKey: 'commands.module_disable',
      permission: 'chat_admin',
      cooldownMs: 500,
      argsSchema: moduleArgument,
      async execute(context, args): Promise<void> {
        const { moduleId } = moduleIdSchema.parse(args);
        if (!context.registry.get(moduleId)) {
          await context.reply.send(context.ctx, context.t('modules.unknown', { moduleId }));
          return;
        }
        await context.registry.setEnabled(context.chatId, moduleId, false, context.userId);
        await context.reply.send(context.ctx, context.t('modules.changed', { moduleId, state: moduleStateLabel(context, false) }));
      },
    },
  ],
};
