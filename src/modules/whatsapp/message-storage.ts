import type Redis from 'ioredis';
import { BufferJSON, type WAMessageKey, type WAMessageContent } from 'baileys';

const MESSAGE_STORAGE_PREFIX = 'wa:msg:';
const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getMessageKey(key: WAMessageKey): string {
  const remoteJid = key.remoteJid ?? '';
  const id = key.id ?? '';
  const participant = key.participant ? `:${key.participant}` : '';
  return `${MESSAGE_STORAGE_PREFIX}${remoteJid}:${id}${participant}`;
}

export async function storeMessage(
  redis: Redis,
  key: WAMessageKey,
  message: WAMessageContent,
): Promise<void> {
  try {
    const redisKey = getMessageKey(key);
    const data = {
      key,
      message,
      timestamp: Date.now(),
    };
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await redis.set(redisKey, serialized, 'EX', MESSAGE_TTL_SECONDS);
  } catch (error) {
    // Log error but don't throw - message sending should continue even if storage fails
    console.error('Failed to store message:', error);
  }
}

export async function getMessage(
  redis: Redis,
  key: WAMessageKey,
): Promise<WAMessageContent | undefined> {
  try {
    const redisKey = getMessageKey(key);
    const stored = await redis.get(redisKey);
    if (!stored) {
      return undefined;
    }
    const data = JSON.parse(stored, BufferJSON.reviver) as {
      key: WAMessageKey;
      message: WAMessageContent;
      timestamp: number;
    };
    return data.message;
  } catch (error) {
    console.error('Failed to retrieve message:', error);
    return undefined;
  }
}

export async function deleteMessage(
  redis: Redis,
  key: WAMessageKey,
): Promise<void> {
  try {
    const redisKey = getMessageKey(key);
    await redis.del(redisKey);
  } catch (error) {
    console.error('Failed to delete message:', error);
  }
}
