export type { AuditOperation, EventCategory, EventSeverity, SnapshotStatus } from './enums.js';
export {
  isObserved,
  mapSnapshot,
  notApplicable,
  notObserved,
  observed,
  redacted,
  unknownSnapshot,
  type Snapshot,
} from './snapshot.js';
export { applyAllowlist, stripForbidden, type AllowlistField, type AuditPolicyContext } from './masking.js';
export {
  computeChanges,
  OPERATION_ABSENCE_RULES,
  type ChangeSet,
  type ChangesUnavailableReason,
  type FieldChange,
  type OperationAbsenceRule,
} from './changes.js';
export {
  AuditSnapshotValidationError,
  UnregisteredAuditEventError,
  UnsupportedAuditEventVersionError,
} from './errors.js';
export type { AuditEventName, AuditEventShapeMap } from './eventMap.js';
export { AUDIT_EVENT_DEFINITIONS } from './definitions.js';
export { AuditEventRegistry, auditEventRegistry } from './registry.js';
export type { AuditEventDefinition, AuditRecord, AuditEventWriter } from './types.js';
export { AuditEventProcessor, auditEventProcessor, type RaiseAuditEventInput } from './eventProcessor.js';
export {
  AUDIT_POLICY_PRIORITY_ORDER,
  classifyAuditPolicyPriority,
  selectAuditPolicyByPriority,
  sortAuditPoliciesByPriority,
  type AuditPolicyPriority,
  type AuditPolicyPriorityCandidate,
  type AuditPolicyPriorityMatch,
  type AuditPolicyResolutionTarget,
} from './policyPriority.js';
export * from './shapes.js';
