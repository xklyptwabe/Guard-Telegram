import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AUDIT_EVENT_DEFINITIONS } from '../../src/lib/audit/definitions.js';

const catalog = readFileSync('docs/audit/event-catalog.md', 'utf8');
const catalogRowEntries = [...catalog.matchAll(/^\| `([^`]+)` \| `(\d+)` \|/gm)].map(
  (match) => [match[1], Number(match[2])] as const,
);
const catalogRows = new Map(catalogRowEntries);

describe('audit event documentation', () => {
  it('catalogs every registered event exactly once', () => {
    expect(catalogRowEntries).toHaveLength(Object.keys(AUDIT_EVENT_DEFINITIONS).length);
    expect([...catalogRows.keys()].sort()).toEqual(Object.keys(AUDIT_EVENT_DEFINITIONS).sort());
  });

  it.each(Object.values(AUDIT_EVENT_DEFINITIONS))('documents $name at its current version', (definition) => {
    expect(catalogRows.get(definition.name)).toBe(definition.version);
  });
});
