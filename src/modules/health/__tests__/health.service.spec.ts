import { HealthService } from '../health.service';

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(() => {
    service = new HealthService();
  });

  describe('formatResponse()', () => {
    it('returns ok status when result.status is "ok"', () => {
      const result = service.formatResponse({ status: 'ok' });
      expect(result.status).toBe('ok');
    });

    it('returns error status for non-ok result', () => {
      const result = service.formatResponse({ status: 'error' });
      expect(result.status).toBe('error');
    });

    it('uses empty objects as defaults for missing fields', () => {
      const result = service.formatResponse({ status: 'ok' });
      expect(result.info).toEqual({});
      expect(result.error).toEqual({});
      expect(result.details).toEqual({});
    });

    it('passes through provided info, error, details', () => {
      const result = service.formatResponse({
        status: 'ok',
        info: { db: { status: 'up' } },
        error: { redis: { status: 'down' } },
        details: { memory: { status: 'ok' } },
      });
      expect(result.info).toEqual({ db: { status: 'up' } });
      expect(result.error).toEqual({ redis: { status: 'down' } });
      expect(result.details).toEqual({ memory: { status: 'ok' } });
    });
  });
});
