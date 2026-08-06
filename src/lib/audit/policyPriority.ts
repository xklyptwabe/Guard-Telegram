export const AUDIT_POLICY_PRIORITY_ORDER = [
  'chat_event_type',
  'chat_module',
  'chat',
  'global_event_type',
  'global_module',
  'global',
] as const;

export type AuditPolicyPriority = (typeof AUDIT_POLICY_PRIORITY_ORDER)[number];

export interface AuditPolicyResolutionTarget {
  readonly chatId?: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly moduleId?: string;
}

export interface AuditPolicyPriorityCandidate {
  readonly policyId: string;
  readonly chatId: string | null;
  readonly eventType: string | null;
  readonly eventVersion: string | null;
  readonly moduleId: string | null;
}

export interface AuditPolicyPriorityMatch<TPolicy extends AuditPolicyPriorityCandidate> {
  readonly policy: TPolicy;
  readonly priority: AuditPolicyPriority;
}

export function classifyAuditPolicyPriority<TPolicy extends AuditPolicyPriorityCandidate>(
  policy: TPolicy,
  target: AuditPolicyResolutionTarget,
): AuditPolicyPriority | undefined {
  const targetsEvent = policy.eventType === target.eventType && policy.eventVersion === target.eventVersion && policy.moduleId === null;
  const targetsModule = target.moduleId !== undefined && policy.eventType === null && policy.eventVersion === null && policy.moduleId === target.moduleId;
  const targetsWholeScope = policy.eventType === null && policy.eventVersion === null && policy.moduleId === null;

  if (policy.chatId !== null) {
    if (target.chatId === undefined || policy.chatId !== target.chatId) return undefined;
    if (targetsEvent) return 'chat_event_type';
    if (targetsModule) return 'chat_module';
    if (targetsWholeScope) return 'chat';
    return undefined;
  }

  if (targetsEvent) return 'global_event_type';
  if (targetsModule) return 'global_module';
  if (targetsWholeScope) return 'global';
  return undefined;
}

export function sortAuditPoliciesByPriority<TPolicy extends AuditPolicyPriorityCandidate>(
  policies: readonly TPolicy[],
  target: AuditPolicyResolutionTarget,
): readonly AuditPolicyPriorityMatch<TPolicy>[] {
  return policies
    .map((policy, index) => ({ policy, priority: classifyAuditPolicyPriority(policy, target), index }))
    .filter((match): match is { readonly policy: TPolicy; readonly priority: AuditPolicyPriority; readonly index: number } => match.priority !== undefined)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.index - right.index)
    .map(({ policy, priority }) => ({ policy, priority }));
}

export function selectAuditPolicyByPriority<TPolicy extends AuditPolicyPriorityCandidate>(
  policies: readonly TPolicy[],
  target: AuditPolicyResolutionTarget,
): AuditPolicyPriorityMatch<TPolicy> | undefined {
  return sortAuditPoliciesByPriority(policies, target)[0];
}

function priorityRank(priority: AuditPolicyPriority): number {
  return AUDIT_POLICY_PRIORITY_ORDER.indexOf(priority);
}
