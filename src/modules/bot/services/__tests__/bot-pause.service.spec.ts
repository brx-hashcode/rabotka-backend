import { BotPauseService, BOT_PAUSE_WINDOW_MS } from '../bot-pause.service';

const PROFILE = 'p-1';

describe('BotPauseService', () => {
  let prisma: {
    profile: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: BotPauseService;

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({ bot_paused_until: null }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new BotPauseService(prisma as never);
  });

  describe('isPaused', () => {
    it('is false when nothing was ever set', async () => {
      await expect(service.isPaused(PROFILE)).resolves.toBe(false);
    });

    it('is true while the deadline is ahead', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        bot_paused_until: new Date(Date.now() + 60_000),
      });
      await expect(service.isPaused(PROFILE)).resolves.toBe(true);
    });

    /**
     * The reason this is a deadline and not a boolean.
     *
     * An admin who toggles the bot off, gets pulled away and never comes back
     * would otherwise cut that person off from the bot for ever, and nothing
     * would surface it.
     */
    it('lapses on its own once the window has passed', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        bot_paused_until: new Date(Date.now() - 1_000),
      });
      await expect(service.isPaused(PROFILE)).resolves.toBe(false);
    });

    it('is false for no profile at all, without asking the database', async () => {
      await expect(service.isPaused(null)).resolves.toBe(false);
      await expect(service.isPaused(undefined)).resolves.toBe(false);
      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    /**
     * FAILS OPEN, and that direction is deliberate: a robot replying over an
     * admin is a bad minute, a bot gone silent for everyone because one query
     * failed is an outage nobody would trace back to this feature.
     */
    it('lets the bot answer when the lookup breaks', async () => {
      prisma.profile.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.isPaused(PROFILE)).resolves.toBe(false);
    });
  });

  describe('pause / resume', () => {
    it('sets a deadline one window out', async () => {
      const before = Date.now();
      const until = await service.pause(PROFILE);
      expect(until.getTime()).toBeGreaterThanOrEqual(
        before + BOT_PAUSE_WINDOW_MS,
      );
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: PROFILE },
        data: { bot_paused_until: until },
      });
    });

    it('clears the deadline outright', async () => {
      await service.resume(PROFILE);
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: PROFILE },
        data: { bot_paused_until: null },
      });
    });
  });

  describe('refresh', () => {
    /**
     * The rule that keeps an admin from silencing the bot by accident: sending
     * a message is not a request to pause. Only a profile ALREADY paused has
     * its deadline pushed out.
     */
    it('only extends a pause that is already running', async () => {
      await service.refresh(PROFILE);
      const [[call]] = prisma.profile.updateMany.mock.calls;
      expect(call.where.id).toBe(PROFILE);
      expect(call.where.bot_paused_until.gt).toBeInstanceOf(Date);
    });

    it('never throws — a failed refresh must not fail the send', async () => {
      prisma.profile.updateMany.mockRejectedValue(new Error('db down'));
      await expect(service.refresh(PROFILE)).resolves.toBeUndefined();
    });
  });
});
