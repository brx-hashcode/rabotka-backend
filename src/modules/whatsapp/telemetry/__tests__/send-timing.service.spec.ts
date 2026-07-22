import type Redis from 'ioredis';
import { SendTimingService } from '../send-timing.service';
import { sendDurationHistogram } from '../metrics';

describe('SendTimingService', () => {
  let redis: jest.Mocked<Pick<Redis, 'set' | 'get' | 'del'>>;
  let service: SendTimingService;
  let observeSpy: jest.SpyInstance;
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<Pick<Redis, 'set' | 'get' | 'del'>>;
    service = new SendTimingService(redis as unknown as Redis);
    observeSpy = jest
      .spyOn(sendDurationHistogram, 'observe')
      .mockImplementation(() => undefined);
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('observe()', () => {
    it('records the histogram and emits a structured JSON line', () => {
      service.observe('twilioAck', 'outbound', 213.4, {
        messageSid: 'SM1',
        to: 'whatsapp:+242060000000',
        templateSid: 'HXabc',
      });

      expect(observeSpy).toHaveBeenCalledWith(
        { stage: 'twilioAck', direction: 'outbound' },
        213.4,
      );

      const line = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line.trim());
      expect(parsed).toMatchObject({
        log: 'wa_send_timing',
        stage: 'twilioAck',
        direction: 'outbound',
        durationMs: 213.4,
        messageSid: 'SM1',
        to: 'whatsapp:+242060000000',
        templateSid: 'HXabc',
      });
      expect(typeof parsed.timestamp).toBe('string');
    });

    it('nulls missing meta fields', () => {
      service.observe('handler', 'inbound', 10);
      const parsed = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(parsed.messageSid).toBeNull();
      expect(parsed.templateSid).toBeNull();
    });
  });

  describe('time()', () => {
    it('returns the wrapped result and records one observation', async () => {
      const result = await service.time('enqueue', 'outbound', {}, () =>
        Promise.resolve('job-1'),
      );
      expect(result).toBe('job-1');
      expect(observeSpy).toHaveBeenCalledTimes(1);
      expect(observeSpy.mock.calls[0][0]).toEqual({
        stage: 'enqueue',
        direction: 'outbound',
      });
      expect(observeSpy.mock.calls[0][1]).toBeGreaterThanOrEqual(0);
    });

    it('still records when the wrapped fn throws', async () => {
      await expect(
        service.time('twilioAck', 'outbound', {}, () =>
          Promise.reject(new Error('boom')),
        ),
      ).rejects.toThrow('boom');
      expect(observeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('markSent()', () => {
    it('writes a TTL-bounded correlation key', async () => {
      await service.markSent('SM9', { to: '+242', templateSid: 'HX1' });
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl] = redis.set.mock.calls[0];
      expect(key).toContain('wa:timing:SM9');
      expect(JSON.parse(value as string)).toMatchObject({
        to: '+242',
        templateSid: 'HX1',
      });
      expect(mode).toBe('EX');
      expect(ttl).toBe(900);
    });

    it('never throws when redis fails', async () => {
      redis.set.mockRejectedValueOnce(new Error('redis down'));
      await expect(service.markSent('SM9', {})).resolves.toBeUndefined();
    });
  });

  describe('recordDelivered()', () => {
    it('computes deliveryMs from the stored sentAt and clears the key', async () => {
      const sentAt = Date.now() - 1200;
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ sentAt, to: '+242', templateSid: null }),
      );

      await service.recordDelivered('SM9');

      expect(observeSpy).toHaveBeenCalledTimes(1);
      expect(observeSpy.mock.calls[0][0]).toEqual({
        stage: 'delivery',
        direction: 'outbound',
      });
      expect(observeSpy.mock.calls[0][1]).toBeGreaterThanOrEqual(1200);
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('SM9'));
    });

    it('is a no-op when no correlation key exists', async () => {
      redis.get.mockResolvedValueOnce(null);
      await service.recordDelivered('SM-unknown');
      expect(observeSpy).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });
});
