import type { TelegramBotModule } from '../core/contracts.js';
import { helpModule } from './global/help.js';
import { moduleAdminModule } from './global/moduleAdmin.js';
import { exampleToolsModule } from './local/exampleTools.js';

export const modules: readonly TelegramBotModule[] = [helpModule, moduleAdminModule, exampleToolsModule];
