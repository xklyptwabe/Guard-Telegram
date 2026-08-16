const en = {
  commands: {
    help: 'show available commands',
    modules: 'show modules for this chat',
    module_enable: 'enable a module: /module_enable <id>',
    module_disable: 'disable a module: /module_disable <id>',
    echo: 'repeat text (local module example)',
    setlocale: 'set the chat language: /setlocale <ru|en>',
    ban: 'ban a member (reply to their message, or by user_id): /ban [reason]',
    unban: 'lift a ban: /unban <user_id>',
    restrict: 'restrict (mute) a member: /restrict <seconds> [reason]',
    unrestrict: 'lift a restriction (unmute): /unrestrict',
    kick: 'remove a member without a permanent ban: /kick [reason]',
    delmsg: 'delete a message (reply to it): /delmsg',
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
    protected: 'Module {{moduleId}} cannot be disabled: it manages this chat modules.',
  },
  chatSettings: {
    changed: 'Chat language changed to {{locale}}.',
  },
  moderation: {
    needsTarget: 'Reply to a member\'s message, or give their user_id as the first argument.',
    needsReply: 'This command only works as a reply to the message you want deleted.',
    needsDuration: 'Give the restriction duration in seconds (a positive integer).',
    succeeded: 'Action "{{action}}" completed.',
    failed: 'Telegram rejected the "{{action}}" action. Check the bot\'s admin rights in this chat.',
    unknown: 'Could not confirm the result of "{{action}}" — Telegram did not respond in time. It will be retried automatically; check back to confirm the outcome.',
    pending: 'Action "{{action}}" is awaiting confirmation and will be retried automatically.',
  },
} as const;

export default en;
