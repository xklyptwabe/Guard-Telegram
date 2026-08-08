import type { DrizzleDatabase } from '../../db/client.js';
import { eventPolicies } from '../../db/schema/audit.js';
import type { EventSeverity } from './enums.js';
import type { AllowlistField } from './masking.js';
import {
  sortAuditPoliciesByPriority,
  type AuditPolicyPriority,
  type AuditPolicyPriorityCandidate,
  type AuditPolicyResolutionTarget,
} from './policyPriority.js';
import { auditEventRegistry } from './registry.js';

export type AuditSnapshotMode = 'metadata' | 'snapshot';
export type AuditPolicyValueName =
  | 'enabled'
  | 'siteVisible'
  | 'snapshotMode'
  | 'allowlist'
  | 'masking'
  | 'retentionDays'
  | 'severity'
  | 'exportAllowed';

export interface AuditPolicyValues {
  readonly enabled: boolean;
  readonly siteVisible: boolean;
  readonly snapshotMode: AuditSnapshotMode;
  readonly allowlist: readonly string[];
  readonly masking: readonly string[];
  readonly retentionDays: number | null;
  readonly severity: EventSeverity;
  readonly exportAllowed: boolean;
}

export interface AuditPolicyValueSource<TValue> {
  readonly value: TValue;
  readonly source: 'default' | 'policy' | 'protected_event';
  readonly policyId?: string;
  readonly priority?: AuditPolicyPriority;
}

export type AuditPolicyValueSources = {
  readonly [Key in AuditPolicyValueName]: AuditPolicyValueSource<AuditPolicyValues[Key]>;
};

export interface EffectiveAuditPolicy {
  readonly eventType: string;
  readonly eventVersion: string;
  readonly values: AuditPolicyValues;
  readonly sources: AuditPolicyValueSources;
}

export interface AuditPolicyResolutionRow extends AuditPolicyPriorityCandidate {
  readonly enabled: boolean | null;
  readonly siteVisible: boolean | null;
  readonly snapshotMode: AuditSnapshotMode | null;
  readonly allowlist: unknown;
  readonly masking: unknown;
  readonly retentionDays: number | null;
  readonly severity: EventSeverity | null;
  readonly exportAllowed: boolean | null;
}

type AuditPolicyReader = Pick<DrizzleDatabase, 'select'>;

type MutableAuditPolicyValues = {
  -readonly [Key in keyof AuditPolicyValues]: AuditPolicyValues[Key];
};

type MutableAuditPolicyValueSources = {
  -readonly [Key in keyof AuditPolicyValueSources]: AuditPolicyValueSources[Key];
};

export async function resolveEffectiveAuditPolicy(
  db: AuditPolicyReader,
  target: AuditPolicyResolutionTarget,
): Promise<EffectiveAuditPolicy> {
  const rows = await readAuditPolicyResolutionRows(db);

  return resolveEffectiveAuditPolicyFromRows(rows, target);
}

export async function readAuditPolicyResolutionRows(
  db: AuditPolicyReader,
): Promise<readonly AuditPolicyResolutionRow[]> {
  return db
    .select({
      policyId: eventPolicies.policyId,
      chatId: eventPolicies.chatId,
      eventType: eventPolicies.eventType,
      eventVersion: eventPolicies.eventVersion,
      moduleId: eventPolicies.moduleId,
      enabled: eventPolicies.enabled,
      siteVisible: eventPolicies.siteVisible,
      snapshotMode: eventPolicies.snapshotMode,
      allowlist: eventPolicies.allowlist,
      masking: eventPolicies.masking,
      retentionDays: eventPolicies.retentionDays,
      severity: eventPolicies.severity,
      exportAllowed: eventPolicies.exportAllowed,
    })
    .from(eventPolicies);
}

export function resolveEffectiveAuditPolicyFromRows(
  rows: readonly AuditPolicyResolutionRow[],
  target: AuditPolicyResolutionTarget,
): EffectiveAuditPolicy {
  const definition = auditEventRegistry.requireSupportedVersion(target.eventType, parseEventVersion(target.eventVersion));
  const defaults = defaultPolicyValues(definition);
  const values: MutableAuditPolicyValues = { ...defaults };
  const sources: MutableAuditPolicyValueSources = defaultPolicySources(defaults);
  const matches = sortAuditPoliciesByPriority(rows, target);

  applyPolicyValue('enabled', values, sources, matches);
  applyPolicyValue('siteVisible', values, sources, matches);
  applyPolicyValue('snapshotMode', values, sources, matches);
  applyPolicyValue('allowlist', values, sources, matches);
  applyPolicyValue('masking', values, sources, matches);
  applyPolicyValue('retentionDays', values, sources, matches);
  applyPolicyValue('severity', values, sources, matches);
  applyPolicyValue('exportAllowed', values, sources, matches);

  if (!definition.canBeDisabled && values.enabled === false && sources.enabled.source === 'policy') {
    values.enabled = true;
    sources.enabled = { value: true, source: 'protected_event' };
  }

  return {
    eventType: target.eventType,
    eventVersion: target.eventVersion,
    values,
    sources,
  };
}

function defaultPolicyValues(definition: ReturnType<typeof auditEventRegistry.requireByName>): AuditPolicyValues {
  return {
    enabled: false,
    siteVisible: definition.siteVisible,
    snapshotMode: 'snapshot',
    allowlist: staticAllowlistFields(definition.allowlist),
    masking: [],
    retentionDays: null,
    severity: definition.severity,
    exportAllowed: false,
  };
}

function parseEventVersion(eventVersion: string): number {
  const match = /^v(\d+)$/.exec(eventVersion);
  if (!match) throw new Error(`Audit event version must use v<number> format, received "${eventVersion}"`);
  return Number(match[1]);
}

function staticAllowlistFields(allowlist: readonly AllowlistField<Record<string, unknown>>[]): readonly string[] {
  return allowlist.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry);
}

function defaultPolicySources(values: AuditPolicyValues): MutableAuditPolicyValueSources {
  return {
    enabled: { value: values.enabled, source: 'default' },
    siteVisible: { value: values.siteVisible, source: 'default' },
    snapshotMode: { value: values.snapshotMode, source: 'default' },
    allowlist: { value: values.allowlist, source: 'default' },
    masking: { value: values.masking, source: 'default' },
    retentionDays: { value: values.retentionDays, source: 'default' },
    severity: { value: values.severity, source: 'default' },
    exportAllowed: { value: values.exportAllowed, source: 'default' },
  };
}

function applyPolicyValue<Key extends AuditPolicyValueName>(
  key: Key,
  values: MutableAuditPolicyValues,
  sources: MutableAuditPolicyValueSources,
  matches: ReturnType<typeof sortAuditPoliciesByPriority<AuditPolicyResolutionRow>>,
): void {
  for (const match of matches) {
    const value = policyValue(match.policy, key);
    if (value === null) continue;
    values[key] = value as AuditPolicyValues[Key];
    const source: AuditPolicyValueSource<AuditPolicyValues[Key]> = {
      value: value as AuditPolicyValues[Key],
      source: 'policy',
      policyId: match.policy.policyId,
      priority: match.priority,
    };
    (sources as Record<AuditPolicyValueName, AuditPolicyValueSource<AuditPolicyValues[AuditPolicyValueName]>>)[key] = source;
    return;
  }
}

function policyValue(policy: AuditPolicyResolutionRow, key: AuditPolicyValueName): AuditPolicyValues[AuditPolicyValueName] | null {
  switch (key) {
    case 'allowlist':
      return parseStringArray(policy.allowlist, 'allowlist');
    case 'masking':
      return parseStringArray(policy.masking, 'masking');
    case 'enabled':
      return policy.enabled;
    case 'siteVisible':
      return policy.siteVisible;
    case 'snapshotMode':
      return policy.snapshotMode;
    case 'retentionDays':
      return policy.retentionDays;
    case 'severity':
      return policy.severity;
    case 'exportAllowed':
      return policy.exportAllowed;
  }
}

function parseStringArray(value: unknown, fieldName: string): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`Audit policy ${fieldName} must be an array of non-empty strings.`);
  }
  return value as readonly string[];
}
