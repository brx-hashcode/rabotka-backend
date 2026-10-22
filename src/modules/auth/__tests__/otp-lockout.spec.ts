import { HttpException } from '@nestjs/common';
import { OTP_DAILY_MISS_LIMIT, consumeOtpWithLockout } from '../otp-store';

/**
 * Pentest A2-NV09 (#885): the per-code limit (5) and the send cap (5 per
 * 15 min) together allowed 25 guesses every 15 minutes, indefinitely.
 */
describe('consumeOtpWithLockout', () => {
  const redisWith = (misses: number | null, matched: 0 | 1) => ({
    get: jest.fn().mockResolvedValue(misses === null ? null : String(misses)),
    eval: jest.fn().mockResolvedValue(matched),
    incr: jest.fn().mockResolvedValue((misses ?? 0) + 1),
    expire: jest.fn().mockResolvedValue(1),
  });

  it('counts a wrong code towards the day', async () => {
    const redis = redisWith(null, 0);
    await expect(
      consumeOtpWithLockout(redis, 'otp:x', 'att:x', '000000'),
    ).resolves.toBe(false);
    expect(redis.incr).toHaveBeenCalledWith('att:x:day');
    expect(redis.expire).toHaveBeenCalledWith('att:x:day', 24 * 60 * 60);
  });

  it('refuses every guess once the day’s limit is reached, the right one too', async () => {
    const redis = redisWith(OTP_DAILY_MISS_LIMIT, 1);
    await expect(
      consumeOtpWithLockout(redis, 'otp:x', 'att:x', '123456'),
    ).rejects.toThrow(HttpException);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('does not count a right code', async () => {
    const redis = redisWith(3, 1);
    await expect(
      consumeOtpWithLockout(redis, 'otp:x', 'att:x', '123456'),
    ).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });
});
