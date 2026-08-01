import type { AuditEventDefinition } from './types.js';
import type { AuditEventName, AuditEventShapeMap } from './eventMap.js';
import {
  auditExportedSchema,
  auditPolicyChangedSchema,
  auditRetentionCompletedSchema,
  botMembershipChangedSchema,
  chatSettingsChangedSchema,
  commandExecutedSchema,
  integrationActionSchema,
  memberStatusChangedSchema,
  messageDeletedSchema,
  messageEditedSchema,
  moderationActionSchema,
  moduleStateChangedSchema,
} from './shapes.js';

function defineAuditEvent<Name extends AuditEventName>(
  name: Name,
  definition: Omit<AuditEventDefinition<AuditEventShapeMap[Name]>, 'name'>,
): AuditEventDefinition<AuditEventShapeMap[Name]> & { readonly name: Name } {
  return { name, ...definition };
}

/**
 * `Record<AuditEventName, ...>` makes registration exhaustive *at compile
 * time*: forgetting an event here, or misspelling one, is a TypeScript
 * error, not a runtime surprise discovered when someone tries to raise it.
 * This directly satisfies the "все события зарегистрированы" criterion.
 */
type AuditEventDefinitions = { readonly [Name in AuditEventName]: AuditEventDefinition<AuditEventShapeMap[Name]> };

export const AUDIT_EVENT_DEFINITIONS: AuditEventDefinitions = {
  'module.state.changed': defineAuditEvent('module.state.changed', {
    version: 1,
    supportedVersions: [1],
    category: 'module',
    severity: 'notice',
    siteVisible: true,
    canBeDisabled: false,
    snapshotSchema: moduleStateChangedSchema,
    // `source` travels alongside `enabled` so a reader can tell an inherited
    // default apart from an explicit per-chat override without needing to
    // separately look up the module's default at read time.
    allowlist: ['chatId', 'moduleId', 'enabled', 'source'],
    // Only the toggled flag (+ its source) is ever observed, not the full
    // resolved module config for the chat — see
    // AuditEventDefinition.sparseSnapshotSchema.
    sparseSnapshotSchema: moduleStateChangedSchema.partial(),
  }),

  'chat.settings.changed': defineAuditEvent('chat.settings.changed', {
    version: 1,
    supportedVersions: [1],
    category: 'chat',
    severity: 'info',
    siteVisible: true,
    canBeDisabled: true,
    snapshotSchema: chatSettingsChangedSchema,
    allowlist: ['chatId', 'locale'],
  }),

  'audit.policy.changed': defineAuditEvent('audit.policy.changed', {
    version: 1,
    supportedVersions: [1],
    category: 'audit',
    severity: 'critical',
    siteVisible: false,
    // Changes to the audit policy itself are always logged — disabling
    // audit-of-audit would defeat the point of the system.
    canBeDisabled: false,
    snapshotSchema: auditPolicyChangedSchema,
    allowlist: ['policyId', 'scope', 'textLoggingEnabled', 'retentionDays'],
  }),

  'member.status.changed': defineAuditEvent('member.status.changed', {
    version: 1,
    supportedVersions: [1],
    category: 'member',
    severity: 'notice',
    siteVisible: true,
    canBeDisabled: true,
    snapshotSchema: memberStatusChangedSchema,
    allowlist: ['chatId', 'userId', 'status'],
  }),

  'bot.membership.changed': defineAuditEvent('bot.membership.changed', {
    version: 1,
    supportedVersions: [1],
    category: 'bot',
    severity: 'warning',
    siteVisible: true,
    // Whether the bot itself is still in a chat is safety-critical operational data.
    canBeDisabled: false,
    snapshotSchema: botMembershipChangedSchema,
    allowlist: ['chatId', 'status'],
  }),

  'moderation.action': defineAuditEvent('moderation.action', {
    version: 1,
    supportedVersions: [1],
    category: 'moderation',
    severity: 'warning',
    siteVisible: true,
    // Accountability for moderation actions must not be switchable off.
    canBeDisabled: false,
    snapshotSchema: moderationActionSchema,
    allowlist: ['chatId', 'targetUserId', 'actorUserId', 'action', 'reason', 'durationSeconds'],
  }),

  'message.edited': defineAuditEvent('message.edited', {
    version: 1,
    supportedVersions: [1],
    category: 'message',
    severity: 'info',
    // Message content is sensitive by default; never surfaced on a public log.
    siteVisible: false,
    canBeDisabled: true,
    snapshotSchema: messageEditedSchema,
    allowlist: [
      'chatId',
      'messageId',
      'userId',
      'editedAt',
      'textLength',
      { field: 'text', when: (policy) => policy.allowMessageTextLogging },
    ],
  }),

  'message.deleted': defineAuditEvent('message.deleted', {
    version: 1,
    supportedVersions: [1],
    category: 'message',
    severity: 'info',
    siteVisible: false,
    canBeDisabled: true,
    snapshotSchema: messageDeletedSchema,
    allowlist: [
      'chatId',
      'messageId',
      'userId',
      'deletedBy',
      { field: 'text', when: (policy) => policy.allowMessageTextLogging },
    ],
  }),

  'command.executed': defineAuditEvent('command.executed', {
    version: 1,
    supportedVersions: [1],
    category: 'command',
    severity: 'info',
    siteVisible: true,
    canBeDisabled: true,
    snapshotSchema: commandExecutedSchema,
    // Note there is no raw-arguments field in the schema at all: the
    // "never store" rule for arbitrary user input is enforced by never
    // capturing it in the first place, not just by allowlist filtering.
    allowlist: ['chatId', 'userId', 'moduleId', 'commandId', 'argsRedacted', 'durationMs', 'success'],
  }),

  'integration.action': defineAuditEvent('integration.action', {
    version: 1,
    supportedVersions: [1],
    category: 'integration',
    severity: 'warning',
    siteVisible: false,
    canBeDisabled: true,
    snapshotSchema: integrationActionSchema,
    allowlist: ['integrationId', 'action', 'targetType', 'targetId', 'statusCode', 'success'],
  }),

  'audit.exported': defineAuditEvent('audit.exported', {
    version: 1,
    supportedVersions: [1],
    category: 'audit',
    severity: 'notice',
    siteVisible: false,
    canBeDisabled: false,
    snapshotSchema: auditExportedSchema,
    allowlist: ['exportId', 'requestedBy', 'format', 'rangeFrom', 'rangeTo', 'rowCount'],
  }),

  'audit.retention.completed': defineAuditEvent('audit.retention.completed', {
    version: 1,
    supportedVersions: [1],
    category: 'audit',
    severity: 'info',
    siteVisible: false,
    canBeDisabled: false,
    snapshotSchema: auditRetentionCompletedSchema,
    allowlist: ['jobId', 'deletedCount', 'retentionDays', 'startedAt', 'finishedAt'],
  }),
};
