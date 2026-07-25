import { z } from 'zod';

import type { TelegramBotModule } from '../../core/contracts.js';

const echoArgs = z.string().trim().min(1).max(256);

export const exampleToolsModule: TelegramBotModule = {
  id: 'example-tools',
  name: 'Example tools',
  description: 'A deliberately disabled local-module example.',
  global: false,
  defaultEnabled: false,
  commands: [
    {
      id: 'example-tools.echo',
      name: 'echo',
      moduleId: 'example-tools',
      descriptionKey: 'commands.echo',
      permission: 'none',
      cooldownMs: 750,
      argsSchema: echoArgs,
      async execute(context, args): Promise<void> {
        const text = echoArgs.parse(args);
        await context.reply.send(context.ctx, text);
      },
    },
  ],
};
