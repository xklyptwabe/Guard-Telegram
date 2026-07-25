const en = {
  commands: {
    help: 'show available commands',
    modules: 'show modules for this chat',
    module_enable: 'enable a module: /module_enable <id>',
    module_disable: 'disable a module: /module_disable <id>',
    echo: 'repeat text (local module example)',
  },
  common: {
    featureDisabled: 'This feature is disabled in this chat.',
    permissionDenied: 'This command requires chat administrator permissions.',
    invalidArguments: 'Invalid command arguments.',
    unknownCommand: 'Command not found.',
    cooldown: 'Please wait before repeating this command.',
    invalidCallback: 'This button is no longer valid.',
    callbackDone: 'Done',
    internalError: 'The command could not be completed. Please try again later.',
    topicUnavailable: 'The forum topic is closed or unavailable.',
  },
  help: {
    title: 'Available commands:',
  },
  modules: {
    title: 'Modules for this chat:',
    enabled: 'enabled',
    disabled: 'disabled',
    changed: 'Module {{moduleId}} is {{state}}.',
    unknown: 'Module {{moduleId}} was not found.',
  },
} as const;

export default en;
