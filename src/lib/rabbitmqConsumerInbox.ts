import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { RABBIT_CONSUMER_LEASE_DURATION_MS } from '../constants.js';
import type { DrizzleDatabase } from '../db/client.js';
import { consumedEnvelopes } from '../db/schema/core.js';
import { stripForbidden } from './audit/masking.js';
import type { Logger } from './logger.js';

export type RabbitEnvelopeClaim = 'claimed' | 'completed' | 'busy';

export class RabbitEnvelopeInbox {
  private readonly workerId = randomUUID();

  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly logger: Logger,
    private readonly leaseDurationMs: number = RABBIT_CONSUMER_LEASE_DURATION_MS,
  ) {}

  public async begin(envelopeId: string): Promise<{ claim: RabbitEnvelopeClaim; attemptCount: number }> {
    await this.db
      .insert(consumedEnvelopes)
      .values({ envelopeId, status: 'received' })
      .onConflictDoNothing({ target: consumedEnvelopes.envelopeId });

    const now = new Date();
    const claimed = await this.db
      .update(consumedEnvelopes)
      .set({
        status: 'processing',
        workerId: this.workerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
        attemptCount: sql`${consumedEnvelopes.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(and(eq(consumedEnvelopes.envelopeId, envelopeId), this.eligibility(now)))
      .returning({ attemptCount: consumedEnvelopes.attemptCount });
    if (claimed[0]) return { claim: 'claimed', attemptCount: claimed[0].attemptCount };

    const [row] = await this.db
      .select({ status: consumedEnvelopes.status, attemptCount: consumedEnvelopes.attemptCount })
      .from(consumedEnvelopes)
      .where(eq(consumedEnvelopes.envelopeId, envelopeId))
      .limit(1);
    if (row?.status === 'completed') return { claim: 'completed', attemptCount: row.attemptCount };
    return { claim: 'busy', attemptCount: row?.attemptCount ?? 0 };
  }

  public async complete(envelopeId: string): Promise<boolean> {
    const now = new Date();
    const updated = await this.db
      .update(consumedEnvelopes)
      .set({ status: 'completed', workerId: null, leaseExpiresAt: null, consumedAt: now, updatedAt: now })
      .where(and(eq(consumedEnvelopes.envelopeId, envelopeId), eq(consumedEnvelopes.workerId, this.workerId), eq(consumedEnvelopes.status, 'processing')))
      .returning({ envelopeId: consumedEnvelopes.envelopeId });
    if (updated.length === 0) {
      this.logger.warn({ event: 'rabbitmq.envelope.lease_lost', details: { envelopeId } });
      return false;
    }
    return true;
  }

  public async fail(envelopeId: string, error: unknown): Promise<boolean> {
    const now = new Date();
    const errorSummary = stripForbidden({ name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) });
    const updated = await this.db
      .update(consumedEnvelopes)
      .set({ status: 'failed', workerId: null, leaseExpiresAt: null, lastError: errorSummary, updatedAt: now })
      .where(and(eq(consumedEnvelopes.envelopeId, envelopeId), eq(consumedEnvelopes.workerId, this.workerId), eq(consumedEnvelopes.status, 'processing')))
      .returning({ envelopeId: consumedEnvelopes.envelopeId });
    return updated.length > 0;
  }

  private eligibility(now: Date) {
    return or(
      eq(consumedEnvelopes.status, 'received'),
      eq(consumedEnvelopes.status, 'failed'),
      and(eq(consumedEnvelopes.status, 'processing'), or(isNull(consumedEnvelopes.leaseExpiresAt), lte(consumedEnvelopes.leaseExpiresAt, now))),
    );
  }
}
