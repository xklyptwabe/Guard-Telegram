export const redisKeys = {
  chatSettings: (chatId: string): string => `chat-settings:${chatId}`,
  moduleState: (chatId: string, moduleId: string): string => `module-state:${chatId}:${moduleId}`,
  cooldown: (chatId: string, userId: string, commandId: string): string => `cooldown:${chatId}:${userId}:${commandId}`,
  lock: (name: string): string => `lock:${name}`,
} as const;
