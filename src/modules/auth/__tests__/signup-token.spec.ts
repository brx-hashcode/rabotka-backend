import { ForbiddenException } from '@nestjs/common';
import {
  consumeSignupToken,
  countSignupUpload,
  issueSignupToken,
  phoneForSignupToken,
  SIGNUP_MAX_UPLOADS,
} from '../signup-token';
import { SignupUploadGuard } from '../guards/signup-upload.guard';
import { sniffFileType } from '../../../common/utils/file-signature.util';

/** A tiny in-memory stand-in for the four Redis commands used. */
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn((k: string, v: string) => {
      data.set(k, v);
      return Promise.resolve('OK');
    }),
    get: jest.fn((k: string) => Promise.resolve(data.get(k) ?? null)),
    incr: jest.fn((k: string) => {
      const n = Number(data.get(k) ?? 0) + 1;
      data.set(k, String(n));
      return Promise.resolve(n);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    del: jest.fn((...keys: string[]) => {
      keys.forEach((k) => data.delete(k));
      return Promise.resolve(keys.length);
    }),
  };
}

describe('signup token', () => {
  it('stands for the verified number until it is spent', async () => {
    const redis = fakeRedis();
    const token = await issueSignupToken(redis as never, '+242061234567');

    expect(await phoneForSignupToken(redis as never, token)).toBe(
      '+242061234567',
    );
    await consumeSignupToken(redis as never, token);
    expect(await phoneForSignupToken(redis as never, token)).toBeNull();
  });

  it('is stored hashed, never in clear', async () => {
    const redis = fakeRedis();
    const token = await issueSignupToken(redis as never, '+242061234567');

    expect([...redis.data.keys()].join()).not.toContain(token);
  });

  it('knows nothing of an unknown, empty or oversized token', async () => {
    const redis = fakeRedis();
    expect(await phoneForSignupToken(redis as never, 'nope')).toBeNull();
    expect(await phoneForSignupToken(redis as never, '')).toBeNull();
    expect(
      await phoneForSignupToken(redis as never, 'x'.repeat(200)),
    ).toBeNull();
  });

  it('allows a bounded number of uploads per signup', async () => {
    const redis = fakeRedis();
    const token = await issueSignupToken(redis as never, '+242061234567');

    for (let i = 0; i < SIGNUP_MAX_UPLOADS; i++) {
      expect(await countSignupUpload(redis as never, token)).toBe(true);
    }
    expect(await countSignupUpload(redis as never, token)).toBe(false);
  });

  it('allows no upload without a valid token', async () => {
    const redis = fakeRedis();
    expect(await countSignupUpload(redis as never, 'forged')).toBe(false);
    expect(await countSignupUpload(redis as never, null)).toBe(false);
  });
});

describe('SignupUploadGuard', () => {
  const contextWith = (headers: Record<string, string>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as never;

  it('lets an upload through with a verified token', async () => {
    const redis = fakeRedis();
    const token = await issueSignupToken(redis as never, '+242061234567');
    const guard = new SignupUploadGuard(redis as never);

    await expect(
      guard.canActivate(contextWith({ 'x-signup-token': token })),
    ).resolves.toBe(true);
  });

  it('refuses an upload without one', async () => {
    const guard = new SignupUploadGuard(fakeRedis() as never);

    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('sniffFileType', () => {
  const pad = (bytes: number[]) =>
    Buffer.from([...bytes, ...Array(16).fill(0)]);

  it.each([
    ['image/jpeg', pad([0xff, 0xd8, 0xff, 0xe0])],
    ['image/png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')],
    ['application/pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'binary')],
  ])('recognises %s from its bytes', (type, buffer) => {
    expect(sniffFileType(buffer)).toBe(type);
  });

  it.each([
    ['html', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['too short', Buffer.from([0xff, 0xd8])],
  ])('recognises nothing in %s', (_name, buffer) => {
    expect(sniffFileType(buffer)).toBeNull();
  });
});
