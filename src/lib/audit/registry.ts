import { AUDIT_EVENT_DEFINITIONS } from './definitions.js';
import type { AuditEventName, AuditEventShapeMap } from './eventMap.js';
import { UnregisteredAuditEventError, UnsupportedAuditEventVersionError } from './errors.js';
import type { AuditEventDefinition } from './types.js';

/**
 * Central, typed registry of every event this system may audit.
 *
 * Two access patterns are supported on purpose:
 *  - `require<Name>` — for code that knows its event name at compile time
 *    (the common case: a module raising its own well-known event).
 *  - `requireByName` — for boundaries that only have a raw `string` (e.g. an
 *    event arriving off a queue/webhook/EventBus listener keyed by name).
 *    Both paths funnel through the same `Map` and the same errors, so
 *    "unregistered event" and "unsupported version" are rejected identically
 *    regardless of how the caller arrived at the event.
 */
export class AuditEventRegistry {
  private readonly definitions: ReadonlyMap<string, AuditEventDefinition<Record<string, unknown>>>;

  public constructor(
    definitions: AuditEventDefinition<Record<string, unknown>>[] = Object.values(
      AUDIT_EVENT_DEFINITIONS,
    ) as unknown as AuditEventDefinition<Record<string, unknown>>[],
  ) {
    const map = new Map<string, AuditEventDefinition<Record<string, unknown>>>();
    for (const definition of definitions) {
      if (map.has(definition.name)) {
        throw new Error(`Duplicate audit event registration for "${definition.name}".`);
      }
      map.set(definition.name, definition);
    }
    this.definitions = map;
  }

  public has(name: string): name is AuditEventName {
    return this.definitions.has(name);
  }

  /** Typed lookup for callers that know their event name statically. */
  public require<Name extends AuditEventName>(name: Name): AuditEventDefinition<AuditEventShapeMap[Name]> {
    return this.requireByName(name) as unknown as AuditEventDefinition<AuditEventShapeMap[Name]>;
  }

  /** Untyped lookup for boundaries that only have a raw event-name string. */
  public requireByName(name: string): AuditEventDefinition<Record<string, unknown>> {
    const definition = this.definitions.get(name);
    if (!definition) throw new UnregisteredAuditEventError(name);
    return definition;
  }

  /** Throws unless `version` is one this registry can still validate for `name`. */
  public requireSupportedVersion(name: string, version: number): AuditEventDefinition<Record<string, unknown>> {
    const definition = this.requireByName(name);
    if (!definition.supportedVersions.includes(version)) {
      throw new UnsupportedAuditEventVersionError(name, version, definition.supportedVersions);
    }
    return definition;
  }

  public list(): readonly AuditEventDefinition<Record<string, unknown>>[] {
    return [...this.definitions.values()];
  }
}

/** Process-wide default registry, pre-loaded with every BOTS-7 event. */
export const auditEventRegistry = new AuditEventRegistry();
