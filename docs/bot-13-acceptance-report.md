# BOTS-13 — Отчёт приёмки: полное интеграционное и сквозное тестирование

Дата: 2026-08-16 · Ветка: `aaxnet/bots-13-provesti-polnoe-intehracionnoe-i-skvoznoe-testirovanie` · Вердикт: **ПРИНЯТО**

## 1. Резюме

Модуль проверен на реальном Test-контуре: живой PostgreSQL 16.14 (UTF8,
отдельный кластер и отдельная база под `TEST_DATABASE_URL`), реальный
webhook-транспорт (`src/core/updates.ts`, HTTP-сервер + grammy-пайплайн),
реальный backend API (`src/api/server.ts` на настоящем порту, запросы по
HTTP), реальный outbox/inbox на таблицах `moderation.pending_operations` и
`core.processed_updates`. По сети эмулируется только сам Telegram Bot API —
через официальный grammy-шов (api-transformer), без моков бизнес-логики.

Итог прогона: **54 файла / 377 тестов — все пройдены, 0 пропущено**
(305 unit + 72 интеграционных; приёмка BOTS-13, пост-приёмочный баг-хант
с исправлениями — см. §8). `npm run lint`, `npm run typecheck` и
`npm run check:locales` — чисто.

Контур воспроизводится локально скриптом
`wip/test-infra-pg/start-pg.mjs` (embedded PostgreSQL 16 + control endpoint
для сценариев отключения). В CI контур уже настроен
(`.gitlab-ci.yml`: `postgres:16-alpine`, `TEST_DATABASE_URL`,
`sslmode=disable`).

## 2. Что добавлено в этой задаче

| Файл | Назначение |
| --- | --- |
| `tests/integration/bots13.resilience.e2e.test.ts` | Временное отключение PostgreSQL (2 теста, через control endpoint) и перезапуск бота во время незавершённой операции (SIGKILL живого дочернего процесса) |
| `tests/integration/bots13.api.e2e.test.ts` | Сквозной сценарий webhook → PostgreSQL → API → сайт, все API-фильтры, cursor pagination по HTTP, tenant-изоляция и отрицательные сценарии прав, XSS через весь конвейер |
| `tests/integration/helpers/bots13Child.ts` | Дочерний ОС-процесс «бота» для сценария рестарта (hang-ban / recover) |
| `tests/fixtures/updates/bots13/*.json` (5 шт.) | Фикстуры Telegram-апдейтов для сквозного сценария (chat_member, my_chat_member, edited_message с XSS-текстом, /ban-команда с entities, событие другого чата) |
| `docs/bot-13-acceptance-report.md` | Этот отчёт |

Ранее добавленные `tests/integration/bot13.e2e.test.ts` (атомарность,
rollback, конкурентность, повторные/out-of-order апдейты, ошибки/таймауты
Telegram, восстановление outbox, 25 параллельных обработчиков, 500 событий
истории, XSS/большие снимки, права, tenant-изоляция) и
`tests/integration/bots9.blockers.e2e.test.ts` прогнаны повторно на том же
контуре — все зелёные.

## 3. Покрытие объёма работ

| Пункт объёма | Где проверено | Результат |
| --- | --- | --- |
| Миграции на отдельной `TEST_DATABASE_URL` | `postgres.test.ts`; `npm run db:migrate` на чистой базе; 18 миграций, схемы `public/core/audit/moderation`, 12 таблиц | ✅ |
| Атомарность бизнес-операции и аудита | `audit.test.ts`: бизнес-строка + событие + снимок + outbox в одной транзакции | ✅ |
| Rollback обеих операций | `audit.test.ts` (ошибка в мутации) + `bots13.resilience` (смерть сервера внутри транзакции: не сохраняется НИЧЕГО) | ✅ |
| Конкурентное изменение одной сущности | `bot13.e2e`: две записи на один subject; `FOR UPDATE`, sequence 1..2 без потерь/дублей, снимок = реально последняя фиксация | ✅ |
| Повторные и не по порядку Telegram Update | `bot13.e2e`: redelivery того же update_id → 1 событие; старый по date не регрессирует снимок; `bots13.api.e2e`: тройная доставка webhook → 1 событие; `bots9`: lease-expiry redelivery inbox | ✅ |
| Ошибка и таймаут Telegram API | `bot13.e2e`: GrammyError → `failed` + ровно одна audit-запись; таймаут → `unknown` + повтор запланирован, аудит не пишется преждевременно | ✅ |
| Восстановление outbox после рестарта | `bot13.e2e` (зависшая `in_progress` строка дожимается) + `bots13.resilience` (SIGKILL живого процесса, новый процесс завершает ровно один раз, `audit_status=written`) | ✅ |
| Все API-фильтры и cursor pagination | `bots13.api.e2e` по реальному HTTP: eventType (один/несколько), category, status, source, subjectType, subjectId, actorId, correlationId, topicId (JSONB telegram_context), moduleId (JSONB metadata), occurredFrom/To, limit, cursor; невалидные значения → 400 | ✅ |
| Tenant-изоляция и права | `bots13.api.e2e`: 401 (нет/чужой/неверный формат токена), 403 (нет permission), изоляция чатов (list/get/filter), platform-tenant; `bot13.e2e`: /ban от не-админа и при выключенном модуле | ✅ |
| XSS и большие JSON-снимки | `bot13.e2e` (байт-в-байт, граница 4096, отказ 4097 без обрезки) + `bots13.api.e2e` (XSS через webhook → PG → API, `application/json`, идентичность сохранённого и отданного) | ✅ |
| Минимум 25 параллельных обработчиков | `bot13.e2e`: 25 одновременных `recordEntityChange` — ни потери, ни дубля, без дедлоков; в prod-конфиге `TELEGRAM_RUNNER_CONCURRENCY=25` | ✅ |
| Временное отключение PostgreSQL | `bots13.resilience`: остановка живого сервера — in-flight запросы падают чисто, процесс жив, ничего частичного не записано; после старта тот же пул сам восстанавливается | ✅ |
| Перезапуск бота во время незавершённой операции | `bots13.resilience`: SIGKILL процесса во время зависшего вызова Telegram; write-ahead строка пережила крах; новый процесс довёл операцию, `telegramCalls=1`, ровно один `moderation.action` | ✅ |
| Большой объём истории | `bot13.e2e`: 500 последовательных изменений — все сохранены, `subject_sequence` 1..500 монотонно без пропусков, снимок = последнему | ✅ |
| Сквозной сценарий Telegram/сайт → PostgreSQL → API → сайт | `bots13.api.e2e`: реальные фикстуры → webhook HTTP → grammy-пайплайн → PostgreSQL → backend API по HTTP → сайт-контракт (site-visible) | ✅ |

## 4. Матрица: событие → fixture → before/after → фактический результат

Все 12 заявленных типов событий реестра (`src/lib/audit/definitions.ts`,
сид миграции 0004) подтверждены. «Фактический результат» — из прогонов на
реальном контуре; все значения сверены с БД/API в тестах.

| Событие | Fixture / источник | before (ожидаемо → фактически) | after (ожидаемо → фактически) | Подтверждение |
| --- | --- | --- | --- | --- |
| `member.status.changed` | `tests/fixtures/updates/bots13/chat_member.promoted.json` (также `chat_member.banned.json`, `chat_member.other-chat.json`) | `not_observed`/`{status:"member"}` → так и записано | `{chatId,userId,status:"administrator"}` → совпало; снимок обновлён, site-visible | `bots13.api.e2e` (webhook+API), `bot13.e2e` (out-of-order, конкурентность, 500 истории) |
| `bot.membership.changed` | `tests/fixtures/updates/bots13/my_chat_member.kicked.json` (также `my_chat_member.promoted.json`, `my_chat_member.rights_changed.json`) | `{status:"administrator"}` (права бота) → записано | `{status:"kicked"}` → совпало | `bots13.api.e2e` (webhook+API) |
| `moderation.action` | `tests/fixtures/updates/bots13/ban.command.json` (/ban реплаем) | `not_applicable` → так и записано | `{action:"ban",targetUserId:"555001",actorUserId,reason:"spam"}` → совпало; outbox: `succeeded`, `audit_status=written`; ровно одна запись | `bots13.api.e2e`, `bot13.e2e`, `bots9`, `bots13.resilience` |
| `message.edited` | `tests/fixtures/updates/bots13/edited_message.json` (XSS-текст; также `tests/fixtures/updates/edited_message.json`) | `not_observed` (первое наблюдение) → так и записано | `{chatId,messageId,userId,editedAt,textLength}` (+`text` при allowlist-политике) → текст байт-в-байт, XSS не искажён | `bots13.api.e2e` (webhook+API, полис-override), `bot13.e2e` (границы 4096/4097) |
| `message.deleted` | нет Telegram-апдейта (Bot API его не доставляет — задокументировано); триггер: `/delmsg` бота | `not_observed`/последний снимок сообщения → по коду | `{chatId,messageId,deletedBy}` → по коду | `moderation.commands.test.ts`, `audit.messageAudit.test.ts`, `auditRead/auditExport` integration |
| `command.executed` | `tests/fixtures/updates/bots13/ban.command.json` (entities: bot_command) | `not_applicable` → так и записано | `{chatId,userId,moduleId,commandId,argsRedacted:true,durationMs,success:true}` → совпало | `bots13.api.e2e` (webhook+API), `dispatcher.commandExecuted.test.ts` |
| `module.state.changed` | команда `/modules …` (unit-фикстуры включения/выключения модуля) | `{enabled,source:"default"}` → по коду | `{enabled,source:"override"}` → по коду; `before/afterSnapshotStatus` зафиксированы | `audit.test.ts` (integration), `auditIdempotency`, `chatSettings.commands`, `registry.setEnabled` |
| `chat.settings.changed` | команды настроек чата (locale и др.) | `{chatId,locale:"en"}` → по коду | `{chatId,locale:"ru"}` → по коду; fail-closed при выключенной политике | `audit.test.ts` (integration: политика выключена → отказ + полный rollback), `chatSettings.test.ts` |
| `audit.policy.changed` | PATCH API политик (unit) | предыдущие значения политики → по коду | новые значения + `lockVersion` → по коду | `auditPolicies.api.test.ts`, `audit.policyStore.test.ts` |
| `integration.action` | внешние операции (S3/RabbitMQ) через outbox | `not_applicable` → по коду | `{integrationId,action,target,statusCode,success}` (в т.ч. `failed`) → по коду | `integrations.externalOperationGateway.test.ts`, `audit.integrationAudit.test.ts` |
| `audit.exported` | экспорт аудита (unit) | `not_applicable` → по коду | метаданные экспорта → по коду | `auditExports.api.test.ts`, `auditExport.test.ts` (integration), `audit.exportService.test.ts` |
| `audit.retention.completed` | job retention (unit) + platform-tenant | `not_applicable` → по коду | статистика очистки → по коду; скрыт от не-системных принципалов | `audit.retention.test.ts`, `auditRead.test.ts` (integration: platform tenant не утекает) |

Примечания к матрице:
- `message.deleted` принципиально не имеет Telegram-фикстуры: Bot API не
  доставляет апдейтов о чужих удалениях (см. док-комментарий
  `src/lib/audit/messageAudit.ts`). Единственный корректный источник —
  собственная операция бота; это подтверждено тестами команды и аудит-слоя.
- `before`/`after` у «site-visible» событий отдаются сайту через
  `GET /api/v1/audit/events` байт-в-байт (проверено в `bots13.api.e2e`).

## 5. Сквозной сценарий (Telegram → PostgreSQL → API → сайт)

`bots13.api.e2e.test.ts`, тест `delivers real fixtures…`:

1. **Telegram → бот**: 5 фикстур доставлены POST-ом на реальный webhook
   (секретный заголовок, схема `webhookUpdateSchema`), полный стек
   middleware: `UpdateInbox` (dedup) → `ensureChat`/upsert пользователя →
   `botMembershipAudit` → модульные обработчики → диспетчер команд
   (права через `getChatMember`, cooldown, /ban).
2. **PostgreSQL**: 5 событий в чате A + 1 в чате B; у `/ban` — write-ahead
   строка `moderation.pending_operations` в `succeeded` c
   `audit_status='written'`; вызовы `getChatMember`/`banChatMember`/
   `sendMessage` прошли через grammy-трансформер.
3. **API**: реальный HTTP-сервер backend API, Bearer-токены, три
   принципала (сайт без системных прав, системный админ, токен без прав).
4. **Сайт**: сайт-контракт = site-visible события. Принципалу «сайт»
   вернулись ровно `bot.membership.changed`, `member.status.changed`,
   `moderation.action`, `command.executed`; `message.edited`
   (site-visible=false по умолчанию) не вернулся ни списком, ни по id
   (404), даже для системного админа; чат B не виден. Опциональная
   политика чата (`site_visible=true, allowlist=["text"]`) включает событие
   и его текст — проверено в XSS-тесте.

## 6. Критерии приёмки

| Критерий | Статус | Чем подтверждён |
| --- | --- | --- |
| Нет потерянных и дублированных событий | ✅ | Повторные доставки (webhook ×3, тот же update_id) → 1 событие; 25 параллельных → ровно 25; 500 истории → ровно 500, sequence без пропусков; рестарт-восстановление → ровно один вызов и один аудит |
| Все заявленные события имеют подтверждённые fixtures | ✅ | Матрица §4: 12/12 типов; Telegram-фикстуры в `tests/fixtures/updates/**` (13 файлов), недоставляемые Telegram-ом типы покрыты триггерами-командами/API (задокументировано) |
| Права доступа проверены отрицательными сценариями | ✅ | 401 ×3 варианта, 403 без permission, /ban от участника, выключенный модуль, изоляция чатов (list/get/filter), platform-tenant только для systemAdmin, DELETE запрещён роли `telegram_bot` (`bots9`) |
| Outbox восстанавливается после сбоя | ✅ | Зависшая `in_progress` строка дожимается; SIGKILL живого процесса → новый процесс завершает, CAS отбрасывает поздний ответ проигравшего lease работника (`bots9`) |
| Пройден сценарий с 25 параллельными обработчиками | ✅ | `bot13.e2e` «25 одновременных операций»: ни потери, ни дубля, без дедлоков (`FOR UPDATE SKIP LOCKED`) |
| Все site-visible события отображаются на сайте | ✅ | Сайт-контракт (`GET /api/v1/audit/events`, `siteVisibleOnly`) возвращает полный site-visible набор с корректными before/after; скрытие невидимых — включая 404 по id — проверено |
| Результаты зафиксированы в отчёте приёмки | ✅ | Этот документ |

## 7. Наблюдения и ограничения

- **Site-visible фильтр строг для всех**: API отдаёт только site-visible
  события даже системному адмминистратору — это контракт сайта, а не
  операторский UI; задокументировано и покрыто тестом (404 по id).
- **Окно WAL-восстановления PostgreSQL**: после жёсткого останова сервер
  принимает TCP, но убивает сессии до завершения восстановления
  («the database system is starting up»). Пул `pg` корректно переподключается;
  в тестах пулы, пережившие рестарт, ретраят транзиентные сбои
  (см. watcher в `bots13.resilience`). Это поведение контура, не дефект модуля.
- **`client.ts` pool-error handler** — обработчик `pool.on('error')` уже
  добавлен ранее (без него разрыв idle-соединения ронял процесс целиком);
  его работа подтверждена сценариями отключения: процесс жив, падают только
  in-flight операции.
- **Сайт (frontend)** живёт в другом репозитории. В рамках этого модуля
  «отображение на сайте» = соблюдение сайт-контракта API (site-visible,
  JSON-only, неизменённые payload-ы). Рендеринг-экранирование — на стороне
  сайта; модуль гарантирует байт-в-байт JSON.
- **Telegram API** эмулируется grammy-трансформером (официальный шов для
  тестирования): реальный сетевой путь до api.telegram.com в Test-контуре
  недоступен без тестового бота; все ветки (успех/confirmed-ошибка/таймаут)
  покрыты.

## 8. Пост-приёмочный баг-хант по всему проекту

После приёмки проведён расширенный поиск дефектов: повторные прогоны
(флакичность — не обнаружена), прогоны с перемешиванием порядка файлов
(скрытых зависимостей нет), coverage-отчёт, адверсариальный набор
(фаззинг API-фильтров, гонки webhook, 100-параллельные записи, 30
параллельных на один субъект, pagination-пытка 300 смешанных событий,
прототип-поллюшн, 200-уровневый JSON), проверка скриптов seed/retention
на реальной БД.

Найдено и **исправлено в этой же ветке**:

| Находка | Приоритет | Исправление |
| --- | --- | --- |
| Самоблокировка чата: `/module_disable module-admin` навсегда отключал админам управление модулями (восстановление только SQL-ом) | HIGH | Флаг `protectFromDisable` в контракте модуля + отказ в `ModuleRegistry.setEnabled` (`ProtectedModuleDisableError`) до каких-либо записей + локализованный ответ команды (`modules.protected`, ru/en). Регрессия покрыта unit-тестами и e2e-сценарием через webhook (`module-admin self-disable lockout regression`) |
| Командные модули `/help` и `/modules` — 0% тестового покрытия (баг выше жил именно там) | MEDIUM | Добавлены `moduleAdmin.commands.test.ts`, `help.commands.test.ts` (список состояний, вкл/выкл, unknown, защищённый отказ, прокидывание ошибок, фильтрация команд по включённости) |
| `Cooldowns` — неограниченный рост Map (медленная утечка памяти) | LOW | Пороговая чистка просроченных ключей в `take` + детерминированный unit-тест |

Зафиксировано, не требует действий: скан скрытых событий в site-visible
выдаче — O(hidden/100) запросов к БД на запрос, корректно завершается
(проверено на 300 событиях), но на сильно скошенных данных будет
медленным; libuv-assert при принудительном exit после остановки webhook
(Windows/Node 24, на прод-путь не влияет). Подтверждено корректным
поведением: контроль секрета webhook (wrong/missing/empty → 401), мусорный
JSON/пустое тело/чужой путь → 400/401, тело >1MB отклоняется без падения
сервера, 10 одновременных дублей апдейта → ровно одно событие, backoff
inbox и перманентный `busy` после исчерпания попыток, идемпотентность
`seed:audit-event-types`, retention-джоб (0 удалений без политик,
событие `audit.retention.completed` на платформенном тенанте).

Итоговое состояние: **54 файла / 377 тестов, все пройдены**; lint,
typecheck (оба конфига), check:locales — чисто.

## 9. Воспроизведение

Контур CI уже настроен в `.gitlab-ci.yml` (`postgres:16-alpine`,
`TEST_DATABASE_URL`, `sslmode=disable`); тесты без `TEST_DATABASE_URL`
пропускаются — прежняя конвенция репозитория.

Сценарии «отключение PostgreSQL» дополнительно используют опциональные
переменные `TEST_PG_CONTROL_URL` / `TEST_PG_CONTROL_TOKEN` (без них эти два
теста пропускаются, остальное работает на любом CI-PostgreSQL). Контрольный
endpoint должен уметь останавливать/запускать СУБД по запросу
(`POST /stop`, `POST /start`, `GET /health`, TCP-токен); в этой проверке
использовался внешний локальный харнесс (embedded PostgreSQL 16 + узел
управления на localhost) — в репозиторий он не входит, поскольку по сути
является описанием Test-инфраструктуры, а не кода модуля. Инструкция по
воспроизведению полного контура — вместе с отчётом задачи (Linear BOTS-13).
