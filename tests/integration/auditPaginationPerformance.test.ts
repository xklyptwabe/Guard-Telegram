import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import {
  buildAuditEventsListQuery,
  encodeAuditEventsCursor,
  type AuditEventsListInput,
} from '../../src/lib/audit/eventReadRepository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const runPerformanceTests = process.env.RUN_AUDIT_PERFORMANCE_TESTS === 'true';
const syntheticEventCount = 100_000;
const deepPagePosition = 90_000;
const occurredAtUpperBound = new Date('2099-01-01T00:00:00.000Z');
const occurredAtLowerBound = new Date(occurredAtUpperBound.getTime() - syntheticEventCount);

let database: DatabaseClient | undefined;

describe.skipIf(!testDatabaseUrl || !runPerformanceTests)('Audit pagination performance', () => {
  beforeAll(() => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'false',
    });
    database = createDatabase(config);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('keeps early and deep cursor pages on bounded index scans', async () => {
    const client = await database!.pool.connect();
    const marker = `bots12-pagination-${randomUUID()}`;

    try {
      await client.query('BEGIN');
      await seedSyntheticHistory(client, marker);
      await client.query('ANALYZE audit.events');

      const cursor = encodeAuditEventsCursor({
        occurredAt: new Date(occurredAtUpperBound.getTime() - deepPagePosition).toISOString(),
        id: deterministicUuid(`${marker}:${deepPagePosition}`),
      });
      const commonFilters = {
        occurredFrom: occurredAtLowerBound,
        occurredTo: occurredAtUpperBound,
      } as const;
      const scenarios = [
        {
          name: 'tenant early',
          expectedIndex: 'events_tenant_occurred_id_idx',
          input: {
            scope: { systemAdmin: false, allowedChatIds: [marker] },
            filters: commonFilters,
            limit: 100,
          },
        },
        {
          name: 'tenant deep',
          expectedIndex: 'events_tenant_occurred_id_idx',
          input: {
            scope: { systemAdmin: false, allowedChatIds: [marker] },
            filters: commonFilters,
            cursor,
            limit: 100,
          },
        },
        {
          name: 'system early',
          expectedIndex: 'events_occurred_id_idx',
          input: {
            scope: { systemAdmin: true, allowedChatIds: [] },
            filters: commonFilters,
            limit: 100,
          },
        },
        {
          name: 'system deep',
          expectedIndex: 'events_occurred_id_idx',
          input: {
            scope: { systemAdmin: true, allowedChatIds: [] },
            filters: commonFilters,
            cursor,
            limit: 100,
          },
        },
      ] as const;

      const results = new Map<string, ExplainResult>();
      for (const scenario of scenarios) {
        await explainAuditPage(client, scenario.input);
        const result = await explainAuditPage(client, scenario.input);
        results.set(scenario.name, result);

        expect(result.nodeTypes, scenario.name).not.toContain('Seq Scan');
        expect(result.nodeTypes, scenario.name).not.toContain('Sort');
        expect(result.indexNames, scenario.name).toContain(scenario.expectedIndex);
        expect(result.actualRows, scenario.name).toBe(101);
        expect(result.executionTimeMs, scenario.name).toBeLessThan(250);
      }

      expectStableDeepPage(results, 'tenant');
      expectStableDeepPage(results, 'system');
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await database!.pool.query('ANALYZE audit.events');
    }
  }, 120_000);
});

async function seedSyntheticHistory(client: PoolClient, marker: string): Promise<void> {
  await client.query(`
    INSERT INTO audit.event_types (
      event_type, event_version, category, description, severity, site_visible, can_be_disabled
    ) VALUES ('message.deleted', 'v1', 'message', 'Pagination performance fixture', 'info', true, true)
    ON CONFLICT (event_type, event_version) DO NOTHING
  `);
  await client.query(
    `
      INSERT INTO audit.events (
        id, event_type, event_version, category, occurred_at, source, status,
        tenant_id, subject_type, subject_id, subject_sequence, idempotency_key,
        before_snapshot_status, after_snapshot_status
      )
      SELECT
        md5($1 || ':' || series::text)::uuid,
        'message.deleted',
        'v1',
        'message',
        $2::timestamptz - series * interval '1 millisecond',
        $1,
        'recorded',
        $1,
        'message',
        $1 || ':' || series::text,
        series,
        $1 || ':' || series::text,
        'not_observed',
        'observed'
      FROM generate_series(1, $3::integer) AS series
    `,
    [marker, occurredAtUpperBound.toISOString(), syntheticEventCount],
  );
}

async function explainAuditPage(client: PoolClient, input: AuditEventsListInput): Promise<ExplainResult> {
  const query = buildAuditEventsListQuery(database!.db, input).toSQL();
  const result = await client.query<ExplainRow>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    query.params,
  );
  const document = result.rows[0]?.['QUERY PLAN'][0];
  if (document === undefined) throw new Error('PostgreSQL did not return an EXPLAIN document.');

  const nodes = flattenPlan(document.Plan);
  return {
    actualRows: document.Plan['Actual Rows'],
    executionTimeMs: document['Execution Time'],
    indexNames: nodes.flatMap((node) => node['Index Name'] === undefined ? [] : [node['Index Name']]),
    nodeTypes: nodes.map((node) => node['Node Type']),
  };
}

function expectStableDeepPage(results: ReadonlyMap<string, ExplainResult>, scope: 'tenant' | 'system'): void {
  const early = results.get(`${scope} early`);
  const deep = results.get(`${scope} deep`);
  if (early === undefined || deep === undefined) throw new Error(`Missing ${scope} pagination plans.`);

  expect(deep.executionTimeMs).toBeLessThanOrEqual(Math.max(early.executionTimeMs * 8, 25));
}

function deterministicUuid(value: string): string {
  const digest = createHash('md5').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

function flattenPlan(plan: ExplainPlan): readonly ExplainPlan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flattenPlan)];
}

interface ExplainResult {
  readonly actualRows: number;
  readonly executionTimeMs: number;
  readonly indexNames: readonly string[];
  readonly nodeTypes: readonly string[];
}

interface ExplainRow {
  readonly 'QUERY PLAN': readonly ExplainDocument[];
}

interface ExplainDocument {
  readonly Plan: ExplainPlan;
  readonly 'Execution Time': number;
}

interface ExplainPlan {
  readonly 'Actual Rows': number;
  readonly 'Index Name'?: string;
  readonly 'Node Type': string;
  readonly Plans?: readonly ExplainPlan[];
}
