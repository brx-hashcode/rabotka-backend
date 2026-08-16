import { BotOrchestratorService } from '../bot-orchestrator.service';

/**
 * `last_login_at` used to move only on a token-issuing sign-in, so a user who
 * lives entirely in the WhatsApp bot read as "never signed in". A bot message
 * arrives from a verified number — the same proof the OTP flow establishes — so
 * it counts, and every command path goes through `handle`.
 */
describe('BotOrchestratorService — bot activity stamps last_login_at', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;

  let prisma: { profile: { update: jest.Mock } };
  let service: BotOrchestratorService;

  /** Reaches the private stamp directly: `handle` needs the whole bot graph. */
  const stamp = (lastLoginAt: Date | null) =>
    (
      service as unknown as {
        recordBotActivity: (id: string, at: Date | null) => void;
      }
    ).recordBotActivity('p-1', lastLoginAt);

  beforeEach(() => {
    prisma = { profile: { update: jest.fn().mockResolvedValue({}) } };
    service = new BotOrchestratorService(
      prisma as never,
      ...(Array.from({ length: 20 }, () => ({})) as never[]),
    );
  });

  it('stamps a profile that has never signed in', () => {
    stamp(null);
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: { last_login_at: expect.any(Date) },
      }),
    );
  });

  it('stamps again once the throttle window has passed', () => {
    stamp(new Date(Date.now() - FIFTEEN_MIN - 1000));
    expect(prisma.profile.update).toHaveBeenCalled();
  });

  /** A menu walk is a dozen messages a minute; each must not be an UPDATE. */
  it('does not write again inside the throttle window', () => {
    stamp(new Date(Date.now() - 60_000));
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });

  /** The reply is what the user is waiting for; a failed stamp must not cost it. */
  it('never throws when the write fails', () => {
    prisma.profile.update.mockRejectedValue(new Error('db down'));
    expect(() => stamp(null)).not.toThrow();
  });
});
