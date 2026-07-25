import type { TelegramBotModule } from './contracts.js';

const moduleIdPattern = /^[a-z][a-z0-9-]*$/;
const commandNamePattern = /^[a-z][a-z0-9_]{0,31}$/;

export function validateModules(modules: readonly TelegramBotModule[]): void {
  const moduleIds = new Set<string>();
  const commandIds = new Set<string>();
  const commandNames = new Set<string>();
  const updateHandlerIds = new Set<string>();

  for (const module of modules) {
    if (!moduleIdPattern.test(module.id)) throw new Error(`Invalid module ID: ${module.id}`);
    if (moduleIds.has(module.id)) throw new Error(`Duplicate module ID: ${module.id}`);
    if (module.global !== module.defaultEnabled) {
      throw new Error(`Module ${module.id} must default ${module.global ? 'enabled' : 'disabled'}`);
    }
    moduleIds.add(module.id);
    for (const handler of module.updateHandlers ?? []) {
      if (!moduleIdPattern.test(handler.id)) throw new Error(`Invalid update handler ID: ${handler.id}`);
      if (updateHandlerIds.has(handler.id)) throw new Error(`Duplicate update handler ID: ${handler.id}`);
      updateHandlerIds.add(handler.id);
    }
    for (const command of module.commands ?? []) {
      if (command.moduleId !== module.id) throw new Error(`Command ${command.id} belongs to the wrong module`);
      if (!commandNamePattern.test(command.name)) throw new Error(`Invalid Telegram command name: ${command.name}`);
      if (command.cooldownMs < 0) throw new Error(`Command ${command.name} has a negative cooldown`);
      if (commandIds.has(command.id)) throw new Error(`Duplicate command ID: ${command.id}`);
      if (commandNames.has(command.name)) throw new Error(`Duplicate command name: ${command.name}`);
      commandIds.add(command.id);
      commandNames.add(command.name);
    }
  }
}
