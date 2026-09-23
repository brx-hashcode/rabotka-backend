import { MessageModerationStatus } from '@prisma/client';
import { ModerationService } from '../moderation.service';

const configWith = (values: Record<string, string> = {}) =>
  ({
    get: jest.fn((key: string, fallback: string) =>
      Promise.resolve(values[key] ?? fallback),
    ),
  }) as never;

describe('ModerationService', () => {
  it('passes a clean message through with nothing attached', async () => {
    const service = new ModerationService(configWith());
    const verdict = await service.review('je peux venir lundi a 8 heures');

    expect(verdict.status).toBe(MessageModerationStatus.CLEAN);
    expect(verdict.spans).toEqual([]);
    expect(verdict.deliveredBody).toBe('je peux venir lundi a 8 heures');
    expect(verdict.ratio).toBe(0);
  });

  it('redacts a number inside a real sentence', async () => {
    const service = new ModerationService(configWith());
    const verdict = await service.review('appelle moi au 06 12 34 56 78 stp');

    expect(verdict.status).toBe(MessageModerationStatus.REDACTED);
    expect(verdict.deliveredBody).not.toMatch(/\d/);
    expect(verdict.deliveredBody).toContain('stp');
    expect(verdict.ratio).toBeGreaterThan(0);
    expect(verdict.ratio).toBeLessThan(0.5);
  });

  it('holds a message that is mostly contact details, and delivers nothing', async () => {
    const service = new ModerationService(configWith());
    const verdict = await service.review('0612345678');

    expect(verdict.status).toBe(MessageModerationStatus.HELD);
    // Not even the holes: a body that is more hole than text says only that
    // somebody tried something.
    expect(verdict.deliveredBody).toBe('');
    // The spans are still returned — the AUTHOR is shown what stayed behind.
    expect(verdict.spans).toHaveLength(1);
  });

  it('respects a configured threshold', async () => {
    const strict = new ModerationService(
      configWith({ 'messaging.held_ratio_threshold': '0.05' }),
    );
    const verdict = await strict.review('appelle moi au 06 12 34 56 78 stp');
    expect(verdict.status).toBe(MessageModerationStatus.HELD);
  });

  it.each([['true'], ['0'], ['-1'], ['2'], ['']])(
    'falls back to the default rather than clamping a threshold of %p',
    async (value) => {
      // Clamping would silently hold or release everything. Falling back keeps
      // the behaviour the one an admin can predict.
      const service = new ModerationService(
        configWith({ 'messaging.held_ratio_threshold': value }),
      );
      const verdict = await service.review('appelle moi au 06 12 34 56 78 stp');
      expect(verdict.status).toBe(MessageModerationStatus.REDACTED);
    },
  );

  it('applies the configured operator prefixes', async () => {
    const service = new ModerationService(
      configWith({ 'messaging.operator_prefixes': '05, 04' }),
    );
    const verdict = await service.review('le 05 11 22 33 marche aussi');

    expect(verdict.status).toBe(MessageModerationStatus.REDACTED);
    expect(verdict.spans[0].matchedBy).toBe('operator_prefix');
  });

  it('masks a number in every message, with no exception', async () => {
    // The `moderate` flag is gone: there is no caller, and no state, that can
    // turn this off for a conversation.
    const service = new ModerationService(configWith());
    const verdict = await service.review('rappelle moi au 06 12 34 56 78');

    expect(verdict.status).toBe(MessageModerationStatus.REDACTED);
    expect(verdict.deliveredBody).not.toMatch(/\d/);
  });
});
