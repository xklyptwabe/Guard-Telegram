# Audit pagination performance

## Method

The BOTS-12 benchmark uses 100,000 synthetic `audit.events` rows ordered by
`occurred_at DESC, id DESC`. It measures the first page and a cursor page after
90,000 rows for both tenant-scoped and system-administrator reads. Every query
uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and the same selection, filters,
ordering, cursor, and `limit + 1` behavior as the production repository.

Run the opt-in check against an isolated test database:

```powershell
$env:RUN_AUDIT_PERFORMANCE_TESTS='true'
$env:TEST_DATABASE_URL='<test database URL>'
npm test -- --run tests/integration/auditPaginationPerformance.test.ts
```

The fixture is created inside a transaction and rolled back in `finally`.
The test then refreshes `audit.events` statistics after cleanup. It asserts that
all four scenarios avoid sequential scans and explicit sorts, use the expected
index, return 101 rows, and keep deep-page execution within a bounded ratio of
the warmed first page.

## Index and cursor contract

- Tenant reads use `(tenant_id, occurred_at DESC, id DESC)`.
- System-wide reads use `(occurred_at DESC, id DESC)`.
- The cursor predicate is `(occurred_at, id) < (:occurred_at, :id)`.
- Pagination remains keyset-based; no offset is used.

Both cursor columns are required in the indexes because `id` is the stable
tie-breaker when events have the same timestamp.

## Test database result

The initial plan was measured on 100,000 synthetic rows before the migration.
The tenant first page used a parallel sequential scan and sort (63.237 ms,
3,273 shared buffer hits); the system-wide first page did the same (47.063 ms,
3,273 hits). A deep system page scanned and rejected 90,000 rows (30.221 ms,
3,234 hits).

With the two composite indexes and tuple cursor predicate, the same test data
used bounded index-only scans in the focused SQL probe:

| Scope | Page | Execution | Shared buffers |
| --- | --- | ---: | ---: |
| Tenant | First | 1.070 ms | 7 |
| Tenant | After 90,000 | 2.642 ms | 5 |
| System | First | 0.336 ms | 7 |
| System | After 90,000 | 0.231 ms | 4 |

The repository integration test is the repeatable acceptance check and uses the
full production row projection rather than the focused `id, occurred_at` probe.

## Manual fixture cleanup

The one-off Supabase probe is isolated by all three markers below. Cleanup must
retain every row that does not match the complete marker set:

```sql
DELETE FROM audit.events
WHERE tenant_id = '__bots12_perf_20260828__'
  AND source = '__bots12_perf_20260828__'
  AND idempotency_key LIKE '__bots12_perf_20260828__:%';

ANALYZE audit.events;
```
