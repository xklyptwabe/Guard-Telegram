import type {
  AuditExportedSnapshot,
  AuditPolicyChangedSnapshot,
  AuditRetentionCompletedSnapshot,
  BotMembershipChangedSnapshot,
  ChatSettingsChangedSnapshot,
  CommandExecutedSnapshot,
  IntegrationActionSnapshot,
  MemberStatusChangedSnapshot,
  MessageDeletedSnapshot,
  MessageEditedSnapshot,
  ModerationActionSnapshot,
  ModuleStateChangedSnapshot,
} from './shapes.js';

/**
 * The full closed set of events this registry knows about. This is the
 * single source of truth for "which events exist" at the type level — it
 * mirrors `BotEvents` in `lib/eventBus.ts` on purpose, so that adding a new
 * audited event follows the same two-step pattern developers already know:
 * add a shape here, then add a definition in `definitions.ts`.
 */
export interface AuditEventShapeMap {
  'module.state.changed': ModuleStateChangedSnapshot;
  'chat.settings.changed': ChatSettingsChangedSnapshot;
  'audit.policy.changed': AuditPolicyChangedSnapshot;
  'member.status.changed': MemberStatusChangedSnapshot;
  'bot.membership.changed': BotMembershipChangedSnapshot;
  'moderation.action': ModerationActionSnapshot;
  'message.edited': MessageEditedSnapshot;
  'message.deleted': MessageDeletedSnapshot;
  'command.executed': CommandExecutedSnapshot;
  'integration.action': IntegrationActionSnapshot;
  'audit.exported': AuditExportedSnapshot;
  'audit.retention.completed': AuditRetentionCompletedSnapshot;
}

export type AuditEventName = keyof AuditEventShapeMap;

export const AUDIT_EVENT_NAMES: readonly AuditEventName[] = [
  'module.state.changed',
  'chat.settings.changed',
  'audit.policy.changed',
  'member.status.changed',
  'bot.membership.changed',
  'moderation.action',
  'message.edited',
  'message.deleted',
  'command.executed',
  'integration.action',
  'audit.exported',
  'audit.retention.completed',
];
