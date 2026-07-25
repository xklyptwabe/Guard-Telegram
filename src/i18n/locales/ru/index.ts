const ru = {
  commands: {
    help: 'показать доступные команды',
    modules: 'показать модули этого чата',
    module_enable: 'включить модуль: /module_enable <id>',
    module_disable: 'выключить модуль: /module_disable <id>',
    echo: 'повторить текст (пример local-модуля)',
  },
  common: {
    featureDisabled: 'Эта функция отключена в данном чате.',
    permissionDenied: 'Для этой команды нужны права администратора чата.',
    invalidArguments: 'Неверные аргументы команды.',
    unknownCommand: 'Команда не найдена.',
    cooldown: 'Подождите немного перед повторной командой.',
    invalidCallback: 'Кнопка больше недействительна.',
    callbackDone: 'Готово',
    internalError: 'Не удалось выполнить команду. Попробуйте позднее.',
    topicUnavailable: 'Тема закрыта или больше недоступна.',
  },
  help: {
    title: 'Доступные команды:',
  },
  modules: {
    title: 'Модули этого чата:',
    enabled: 'включён',
    disabled: 'выключен',
    changed: 'Модуль {{moduleId}} {{state}}.',
    unknown: 'Модуль {{moduleId}} не найден.',
  },
} as const;

export default ru;
