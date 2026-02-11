import type Redis from 'ioredis';
import {
  type AuthenticationState,
  type SignalDataTypeMap,
  BufferJSON,
  initAuthCreds,
} from 'baileys';
import { proto } from 'baileys/WAProto';

const CREDS_KEY = 'creds';

function fixFileName(file: string): string {
  return (file ?? '').replaceAll('/', '__').replaceAll(':', '-');
}

function keyFile(category: string, id: string): string {
  return `${category}-${fixFileName(id)}`;
}

export interface RedisAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useRedisAuthState(
  redis: Redis,
  prefix: string,
): Promise<RedisAuthStateResult> {
  const pref = prefix.endsWith(':') ? prefix : `${prefix}:`;

  const writeData = async (data: unknown, file: string): Promise<void> => {
    const key = `${pref}${fixFileName(file)}`;
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await redis.set(key, serialized);
  };

  const readData = async (file: string): Promise<unknown> => {
    try {
      const key = `${pref}${fixFileName(file)}`;
      const data = await redis.get(key);
      if (data == null) return null as unknown;
      return JSON.parse(data, BufferJSON.reviver) as unknown;
    } catch {
      return null as unknown;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    const key = `${pref}${fixFileName(file)}`;
    await redis.del(key);
  };

  const creds =
    ((await readData(CREDS_KEY)) as AuthenticationState['creds'] | null) ??
    initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const data: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = (await readData(keyFile(type, id))) as
              | SignalDataTypeMap[T]
              | null
              | undefined;
            if (
              type === 'app-state-sync-key' &&
              value != null &&
              typeof value === 'object'
            ) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Parameters<
                  typeof proto.Message.AppStateSyncKeyData.fromObject
                >[0],
              ) as unknown as SignalDataTypeMap[T];
            }
            data[id] = value as SignalDataTypeMap[T];
          }),
        );
        return data;
      },
      set: async (data: {
        [T in keyof SignalDataTypeMap]?: {
          [id: string]: SignalDataTypeMap[T] | null;
        };
      }): Promise<void> => {
        const tasks: Promise<void>[] = [];

        for (const category in data) {
          const map = data[category as keyof SignalDataTypeMap];
          if (map == null) continue;
          for (const id in map) {
            const value = map[id];
            const file = keyFile(category, id);
            tasks.push(
              value == null
                ? removeData(file).then(() => undefined)
                : writeData(value, file),
            );
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = (): Promise<void> => writeData(creds, CREDS_KEY);

  return { state, saveCreds };
}

export async function clearRedisAuthState(
  redis: Redis,
  prefix: string,
): Promise<void> {
  const pref = prefix.endsWith(':') ? prefix : `${prefix}:`;
  const pattern = `${pref}*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}
