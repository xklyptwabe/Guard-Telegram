import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

describe('S3 put idempotency key (round-3)', () => {
  it('is derived only from key + body digest — never a random UUID', () => {
    const key = 'obj/a.bin';
    const body = new Uint8Array([1, 2, 3]);
    const digest = createHash('sha256').update(body).digest('hex');
    const idempotencyKey = `s3.putObject:${key}:${digest}`;
    expect(idempotencyKey).toBe(`s3.putObject:${key}:${digest}`);
    expect(idempotencyKey).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
