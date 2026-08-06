import { describe, expect, it } from 'vitest';

import {
  AUDIT_POLICY_PRIORITY_ORDER,
  classifyAuditPolicyPriority,
  selectAuditPolicyByPriority,
  sortAuditPoliciesByPriority,
  type AuditPolicyPriorityCandidate,
} from '../../src/lib/audit/policyPriority.js';

const target = {
  chatId: 'chat-1',
  eventType: 'message.deleted',
  eventVersion: 'v1',
  moduleId: 'moderation',
} as const;

describe('audit policy priority', () => {
  it('documents the required priority order from most specific to least specific', () => {
    expect(AUDIT_POLICY_PRIORITY_ORDER).toEqual([
      'chat_event_type',
      'chat_module',
      'chat',
      'global_event_type',
      'global_module',
      'global',
    ]);
  });

  it.each([
    [
      'chat_event_type',
      { policyId: 'chat-event', chatId: 'chat-1', eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
    ],
    ['chat_module', { policyId: 'chat-module', chatId: 'chat-1', eventType: null, eventVersion: null, moduleId: 'moderation' }],
    ['chat', { policyId: 'chat', chatId: 'chat-1', eventType: null, eventVersion: null, moduleId: null }],
    [
      'global_event_type',
      { policyId: 'global-event', chatId: null, eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
    ],
    ['global_module', { policyId: 'global-module', chatId: null, eventType: null, eventVersion: null, moduleId: 'moderation' }],
    ['global', { policyId: 'global', chatId: null, eventType: null, eventVersion: null, moduleId: null }],
  ] satisfies readonly [string, AuditPolicyPriorityCandidate][])('classifies %s policy rows', (expected, policy) => {
    expect(classifyAuditPolicyPriority(policy, target)).toBe(expected);
  });

  it('ignores policies for a different chat, event type, version, or module', () => {
    const policies: readonly AuditPolicyPriorityCandidate[] = [
      { policyId: 'other-chat', chatId: 'chat-2', eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
      { policyId: 'other-event', chatId: null, eventType: 'message.edited', eventVersion: 'v1', moduleId: null },
      { policyId: 'other-version', chatId: null, eventType: 'message.deleted', eventVersion: 'v2', moduleId: null },
      { policyId: 'other-module', chatId: null, eventType: null, eventVersion: null, moduleId: 'tools' },
    ];

    expect(sortAuditPoliciesByPriority(policies, target)).toEqual([]);
  });

  it('selects the highest-priority applicable policy independent of input order', () => {
    const policies: readonly AuditPolicyPriorityCandidate[] = [
      { policyId: 'global', chatId: null, eventType: null, eventVersion: null, moduleId: null },
      { policyId: 'global-module', chatId: null, eventType: null, eventVersion: null, moduleId: 'moderation' },
      { policyId: 'global-event', chatId: null, eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
      { policyId: 'chat', chatId: 'chat-1', eventType: null, eventVersion: null, moduleId: null },
      { policyId: 'chat-module', chatId: 'chat-1', eventType: null, eventVersion: null, moduleId: 'moderation' },
      { policyId: 'chat-event', chatId: 'chat-1', eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
    ];

    expect(selectAuditPolicyByPriority(policies, target)).toEqual({
      policy: { policyId: 'chat-event', chatId: 'chat-1', eventType: 'message.deleted', eventVersion: 'v1', moduleId: null },
      priority: 'chat_event_type',
    });
    expect(sortAuditPoliciesByPriority(policies, target).map((match) => match.priority)).toEqual([
      'chat_event_type',
      'chat_module',
      'chat',
      'global_event_type',
      'global_module',
      'global',
    ]);
  });
});
