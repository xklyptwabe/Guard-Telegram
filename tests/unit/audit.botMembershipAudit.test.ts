import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { recordBotMembershipChanged } from '../../src/lib/audit/botMembershipAudit.js';
import type { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { Logger } from '../../src/lib/logger.js';

function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`../fixtures/updates/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fakeAuditService(currentSnapshotRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const fakeTx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(currentSnapshotRows) }) }) }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('recordBotMembershipChanged', () => {
  it('audits the bot being promoted to administrator', async () => {
    const fixture = loadFixture('my_chat_member.promoted.json');
    const { audit, calls } = fakeAuditService();
    const ctx = { myChatMember: fixture.my_chat_member } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), botId: 'bot-42', chatId: '-1001111111111' }, () => recordBotMembershipChanged(audit, logger(), ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string; subjectId: string; idempotencyKey: string }; result: { before?: Record<string, unknown>; after?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('bot.membership.changed');
    expect(call.input.subjectId).toBe('-1001111111111');
    expect(call.input.idempotencyKey).toBe('bot.membership.changed:telegram-update:bot-42:100005:-1001111111111');
    expect(call.result.before).toMatchObject({ status: 'member' });
    expect(call.result.after).toMatchObject({ status: 'administrator' });
  });

  it('audits the bot being removed from a chat', async () => {
    const fixture = loadFixture('my_chat_member.kicked.json');
    const { audit, calls } = fakeAuditService();
    const ctx = { myChatMember: fixture.my_chat_member } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordBotMembershipChanged(audit, logger(), ctx));

    const call = calls[0] as { result: { after?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ status: 'kicked' });
  });

  it('BOTS-9 review HIGH-2: a rights-only change (status stays "administrator") is operation "update", not "noop" — losing can_restrict_members must not look like nothing happened', async () => {
    const fixture = loadFixture('my_chat_member.rights_changed.json');
    const { audit, calls } = fakeAuditService();
    const ctx = { myChatMember: fixture.my_chat_member } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordBotMembershipChanged(audit, logger(), ctx));

    const call = calls[0] as { result: { before?: Record<string, unknown>; after?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'update' });
    expect((call.result.before as { rights?: { canRestrictMembers?: boolean } })?.rights?.canRestrictMembers).toBe(true);
    expect((call.result.after as { rights?: { canRestrictMembers?: boolean } })?.rights?.canRestrictMembers).toBe(false);
  });

  it('records the incoming after state for an older update without regressing the current snapshot', async () => {
    const currentObservedAt = new Date(2_000_000_000 * 1000).toISOString();
    const { audit, calls } = fakeAuditService([
      {
        snapshotData: {
          chatId: '-1001111111111',
          status: 'kicked',
          observedAt: currentObservedAt,
          observedUpdateId: 200,
        },
      },
    ]);
    const fixture = loadFixture('my_chat_member.promoted.json');
    const ctx = {
      myChatMember: {
        ...fixture.my_chat_member,
        date: 1_000_000_000,
      },
    } as never;

    await runWithUpdateContext({ updateId: '100', chatId: '-1001111111111', botId: '42' }, () =>
      recordBotMembershipChanged(audit, logger(), ctx),
    );

    const call = calls[0] as {
      result: {
        after?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        snapshotData?: Record<string, unknown>;
      };
    };
    expect(call.result.after).toMatchObject({ status: 'administrator' });
    expect(call.result.snapshotData).toMatchObject({
      status: 'kicked',
      observedAt: currentObservedAt,
      observedUpdateId: 200,
    });
    expect(call.result.metadata).toMatchObject({ operation: 'noop', outOfOrder: true });
  });

  it('keeps newer bot rights in the snapshot while auditing rights from the stale update', async () => {
    const currentObservedAt = new Date(2_000_000_000 * 1000).toISOString();
    const currentRights = {
      canManageChat: true,
      canDeleteMessages: true,
      canManageVideoChats: true,
      canRestrictMembers: true,
      canPromoteMembers: false,
      canChangeInfo: true,
      canInviteUsers: true,
      isAnonymous: false,
    };
    const { audit, calls } = fakeAuditService([
      {
        snapshotData: {
          chatId: '-1001111111111',
          status: 'administrator',
          rights: currentRights,
          observedAt: currentObservedAt,
          observedUpdateId: 200,
        },
      },
    ]);
    const fixture = loadFixture('my_chat_member.rights_changed.json');
    const ctx = {
      myChatMember: {
        ...fixture.my_chat_member,
        date: 1_000_000_000,
      },
    } as never;

    await runWithUpdateContext({ updateId: '100', chatId: '-1001111111111', botId: '42' }, () =>
      recordBotMembershipChanged(audit, logger(), ctx),
    );

    const call = calls[0] as {
      result: {
        after?: { rights?: { canRestrictMembers?: boolean } };
        snapshotData?: { rights?: { canRestrictMembers?: boolean } };
      };
    };
    expect(call.result.after?.rights?.canRestrictMembers).toBe(false);
    expect(call.result.snapshotData?.rights?.canRestrictMembers).toBe(true);
  });

  it('is never gated by any module — this test calls it directly, matching how it is wired in core/updates.ts (registerBotMembershipAudit), not through registerModuleUpdateHandlers', async () => {
    // Documentation-as-test: there is no `enabled` check anywhere in this
    // producer's own logic, unlike module-gated producers.
    const fixture = loadFixture('my_chat_member.promoted.json');
    const { audit, calls } = fakeAuditService();
    const ctx = { myChatMember: fixture.my_chat_member } as never;
    await runWithUpdateContext({ updateId: '1', chatId: '-1001111111111' }, () => recordBotMembershipChanged(audit, logger(), ctx));
    expect(calls).toHaveLength(1);
  });

  it('is a no-op when there is no my_chat_member on the update', async () => {
    const { audit, calls } = fakeAuditService();
    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => recordBotMembershipChanged(audit, logger(), {} as never));
    expect(calls).toHaveLength(0);
  });

  it('round-3: infrastructure audit failure is NOT swallowed — throws AuditFinalizationPendingError', async () => {
    const { AuditFinalizationPendingError } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
    const audit = { recordEntityChange: vi.fn(async () => { throw new Error('db down'); }) } as unknown as AuditService;
    const fixture = loadFixture('my_chat_member.promoted.json');
    const ctx = { myChatMember: fixture.my_chat_member } as never;
    await expect(
      runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordBotMembershipChanged(audit, logger(), ctx)),
    ).rejects.toBeInstanceOf(AuditFinalizationPendingError);
  });
});
