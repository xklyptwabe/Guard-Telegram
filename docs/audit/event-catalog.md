# Audit event and contract catalog

This catalog describes the contracts implemented by this repository. The executable source of truth for audit event metadata is `src/lib/audit/definitions.ts`; snapshot validation lives in `src/lib/audit/shapes.ts`. A catalog entry does not expand an event's persistence allowlist.

## Event registry

The registry version is numeric. Version `1` is persisted and exposed as `v1` by the storage and API layers. Every event currently produces version `1` and accepts only version `1`.

| Event | Version | Category | Severity | Site visible | Disableable | Snapshot schema | Producer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `module.state.changed` | `1` | `module` | `notice` | yes | no | `moduleStateChangedSchema` with sparse override support | `ModuleRegistry.setEnabled` |
| `chat.settings.changed` | `1` | `chat` | `info` | yes | yes | `chatSettingsChangedSchema` | chat settings service |
| `audit.policy.changed` | `1` | `audit` | `critical` | no | no | `auditPolicyChangedSchema` | `updateAuditPolicyWithAudit` |
| `member.status.changed` | `1` | `member` | `notice` | yes | yes | `memberStatusChangedSchema` / `memberStatusSnapshotSchema` | Telegram `chat_member` audit handler |
| `bot.membership.changed` | `1` | `bot` | `warning` | yes | no | `botMembershipChangedSchema` / `botMembershipSnapshotSchema` | Telegram `my_chat_member` audit handler |
| `moderation.action` | `1` | `moderation` | `warning` | yes | no | `moderationActionSchema` | moderation external-operation finalizer |
| `message.edited` | `1` | `message` | `info` | no | yes | `messageEditedSchema` | `edited_message` / `edited_channel_post` audit handler |
| `message.deleted` | `1` | `message` | `info` | no | yes | `messageDeletedSchema` | bot-owned `deleteMessage` finalizer |
| `command.executed` | `1` | `command` | `info` | yes | yes | `commandExecutedSchema` | command audit finalizer |
| `integration.action` | `1` | `integration` | `warning` | no | yes | `integrationActionSchema` | S3, RabbitMQ, reply, command-menu, and webhook integration finalizers |
| `audit.exported` | `1` | `audit` | `notice` | no | no | `auditExportedSchema` | `createAuditExport` |
| `audit.retention.completed` | `1` | `audit` | `info` | no | no | `auditRetentionCompletedSchema` | `runAuditRetentionJob` |

`Site visible` is the registry default. The effective audit policy still decides whether a permitted event is returned by the site-facing API. `Disableable: no` means database and application policy checks reject attempts to turn the event off.

## Persistence allowlists

The fields below are the maximum event-specific allowlists. They are intersected with the effective policy and the global forbidden-key/value filter before persistence.

| Event | Allowed snapshot fields |
| --- | --- |
| `module.state.changed` | `chatId`, `moduleId`, `enabled`, `source` |
| `chat.settings.changed` | `chatId`, `locale` |
| `audit.policy.changed` | `policyId`, `scope`, `targetType`, `chatId`, `eventType`, `eventVersion`, `moduleId`, `enabled`, `siteVisible`, `snapshotMode`, `allowlist`, `masking`, `retentionDays`, `severity`, `exportAllowed`, `lockVersion` |
| `member.status.changed` | `chatId`, `userId`, `status`, `observedAt`, `observedUpdateId` |
| `bot.membership.changed` | `chatId`, `botId`, `status`, `observedAt`, `observedUpdateId`, `rights` |
| `moderation.action` | `chatId`, `targetUserId`, `actorUserId`, `action`, `reason`, `durationSeconds`, `partialOutcome` |
| `message.edited` | `chatId`, `messageId`, `userId`, `editedAt`, `observedUpdateId`, `textLength`, conditional `text` |
| `message.deleted` | `chatId`, `messageId`, `userId`, `deletedBy`, conditional `text` |
| `command.executed` | `chatId`, `userId`, `moduleId`, `commandId`, `argsRedacted`, `durationMs`, `success` |
| `integration.action` | `integrationId`, `action`, `targetType`, `targetId`, `statusCode`, `outcome`, `success` |
| `audit.exported` | `exportId`, `requestedBy`, `format`, `rangeFrom`, `rangeTo`, `rowCount` |
| `audit.retention.completed` | `jobId`, `deletedCount`, `retentionDays`, `batchSize`, `startedAt`, `finishedAt` |

Message `text` is eligible only when the effective chat policy explicitly allows message text logging. Eligibility is not permission to bypass masking or the effective policy allowlist.

## Snapshot and outcome states

Event `before` and `after` values carry one of these explicit states:

- `observed`: validated data is present;
- `not_observed`: the bot has no prior or resulting observation;
- `redacted`: a value existed but policy removed it;
- `unknown`: the state cannot be established safely;
- `not_applicable`: the operation has no meaningful snapshot for that side.

An absent snapshot is stored as SQL `NULL`, never `{}` or an inferred value. `audit.entity_snapshots` separately uses `current` and `archived` as lifecycle states. Audit event outcomes are `recorded`, `failed`, or `unknown`; `unknown` is a first-class terminal statement that the external result could not be proven.

## Other versioned contracts

| Contract | Current version | Compatibility boundary | Source of truth |
| --- | --- | --- | --- |
| Audit event definition | `1` in the registry, `v1` in persistence/API | Event name plus version selects schema, policy, and validation | `src/lib/audit/definitions.ts`, `src/lib/audit/serviceAdapter.ts` |
| Backend audit API | `/api/v1` | HTTP path version; cursor and response validation remain endpoint-specific | `docs/openapi/backend-api.openapi.json` |
| OpenAPI document | OpenAPI `3.1.0`, service document `0.1.0` | Describes the current `/api/v1/audit/*` routes | `docs/openapi/backend-api.openapi.json` |
| Callback data | `v1:<command>:<base64url-arguments>` | Telegram's 64-byte callback field; unknown versions are rejected | `src/core/dispatcher.ts` |
| Pending-operation metadata | `formatVersion: 1` | Internal write-ahead recovery envelope; legacy flat rows remain readable | `src/lib/moderation/pendingOperationsOutbox.ts` |

Changing an existing contract in place is not backward compatibility. Add a supported event version or a new externally visible protocol version, retain readers for stored data still within retention, update this catalog and OpenAPI where applicable, and cover both old and new forms with tests.