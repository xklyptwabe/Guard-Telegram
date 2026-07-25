export const SERVICE_NAME = 'telegram-bot';
export const PROCESSED_UPDATE_RETENTION_DAYS = 7;
export const CALLBACK_VERSION = 'v1';

export const MODULE_IDS = {
  help: 'help',
  moduleAdmin: 'module-admin',
} as const;

export const COMMAND_NAMES = {
  help: 'help',
  modules: 'modules',
  moduleEnable: 'module_enable',
  moduleDisable: 'module_disable',
} as const;
