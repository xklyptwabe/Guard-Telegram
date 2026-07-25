import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/lib/logger.js';
import { ReplyService } from '../../src/lib/reply.js';

function topicContext(sendMessage: ReturnType<typeof vi.fn>): Context {
  return {
    chat: { id: -100123, type: 'supergroup' },
    update: {
      update_id: 1,
      message: { message_thread_id: 42 },
    },
    api: { sendMessage },
  } as unknown as Context;
}

describe('topic replies', () => {
  it('falls back to the parent chat only with both opt-ins', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Bad Request: TOPIC_CLOSED')).mockResolvedValueOnce({});
    const reply = new ReplyService({ telegramTopicFallbackToChat: true }, new Logger({ nodeEnv: 'test', logLevel: 'error' }));
    await reply.send(topicContext(sendMessage), 'safe response', { allowTopicFallback: true });
    expect(sendMessage).toHaveBeenNthCalledWith(1, -100123, 'safe response', { message_thread_id: 42 });
    expect(sendMessage).toHaveBeenNthCalledWith(2, -100123, 'safe response');
  });

  it('does not leave a topic without the command-level opt-in', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('message thread not found'));
    const reply = new ReplyService({ telegramTopicFallbackToChat: true }, new Logger({ nodeEnv: 'test', logLevel: 'error' }));
    await expect(reply.send(topicContext(sendMessage), 'safe response')).rejects.toThrow(/message thread not found/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
