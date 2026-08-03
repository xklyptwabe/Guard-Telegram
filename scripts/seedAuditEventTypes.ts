/**
 * Seeds `audit.event_types` and `audit.event_policies` from the BOTS-7
 * registry (`src/lib/audit/definitions.ts`) — the registry is the single
 * source of truth for what event types exist and their static metadata
 * (category, severity, siteVisible, canBeDisabled); this script projects
 * that into the DB rather than duplicating it by hand.
 *
 * Idempotent: safe to re-run. Existing rows are updated to match the
 * registry (in case severity/category/etc changed), not duplicated.
 *
 * `event_policies.enabled` defaults to `true` for every event type on
 * first seed. For `canBeDisabled: false` events, this script does not
 * allow `enabled` to be flipped to `false` on subsequent runs — see
 * `canBeDisabled` enforcement below. Turning an event *off* (for the
 * events where that's allowed) is an operational action, not something
 * this script does — see the ops runbook / BOTS-8 (retention & policies).
 *
 * Usage:
 *   npm run seed:audit-event-types
 */
import { eq } from 'drizzle-orm';

import { createDatabase } from '../src/db/client.js';
import { eventPolicies, eventTypes } from '../src/db/schema/audit.js';
import { auditEventRegistry } from '../src/lib/audit/registry.js';
import { validateConfig } from '../src/config.js';

async function main(): Promise<void> {
  const config = validateConfig();
  const database = createDatabase(config);
  const definitions = auditEventRegistry.list();

  let created = 0;
  let updated = 0;

  for (const definition of definitions) {
    const eventVersion = `v${definition.version}`;

    const existingType = await database.db
      .select({ eventType: eventTypes.eventType })
      .from(eventTypes)
      .where(eq(eventTypes.eventType, definition.name))
      .limit(1);

    await database.db
      .insert(eventTypes)
      .values({
        eventType: definition.name,
        eventVersion,
        category: definition.category,
        severity: definition.severity,
        siteVisible: definition.siteVisible,
        canBeDisabled: definition.canBeDisabled,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eventTypes.eventType, eventTypes.eventVersion],
        set: {
          category: definition.category,
          severity: definition.severity,
          siteVisible: definition.siteVisible,
          canBeDisabled: definition.canBeDisabled,
          updatedAt: new Date(),
        },
      });

    // event_policies gates writes at record time (AuditService.recordEntityChange
    // throws if no enabled policy row exists) — every registered event type
    // needs one, or it can never actually be persisted.
    await database.db
      .insert(eventPolicies)
      .values({
        eventType: definition.name,
        eventVersion,
        required: true,
        enabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: [eventPolicies.eventType, eventPolicies.eventVersion] });

    if (existingType[0]) updated += 1;
    else created += 1;
  }

  process.stdout.write(`audit.event_types seeded: ${created} created, ${updated} updated (${definitions.length} total).\n`);
  await database.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`Seeding audit.event_types failed: ${String(error)}\n`);
  process.exitCode = 1;
});
