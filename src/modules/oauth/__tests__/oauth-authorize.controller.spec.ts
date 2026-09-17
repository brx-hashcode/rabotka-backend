import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { AuthService } from '../../auth/auth.service';
import { OAuthAuthorizeController } from '../oauth-authorize.controller';
import type { OAuthAuthorizationService } from '../services/oauth-authorization.service';
import type { OAuthInteractionService } from '../services/oauth-interaction.service';
import { OAuthSandboxService } from '../services/oauth-sandbox.service';
import { OAuthError } from '../oauth-error';

const SANDBOX_PHONE = '+242061111111';
const SANDBOX_PHONE_UNVERIFIED = '+242061111112';
const REAL_PHONE = '+237690000042';
const SANDBOX_OTP = '111111';

async function expectOAuthError(
  promise: Promise<unknown>,
): Promise<OAuthError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OAuthError);
  return caught as OAuthError;
}

function build(interaction: Record<string, unknown>) {
  const interactions = {
    require: jest.fn().mockResolvedValue(interaction),
    patch: jest.fn().mockResolvedValue(interaction),
    recordFailedOtp: jest.fn().mockResolvedValue({ attemptsLeft: 4 }),
  } as unknown as jest.Mocked<OAuthInteractionService>;

  const auth = {
    sendOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyOtpAndGetProfile: jest.fn().mockResolvedValue({ id: 'p-1' }),
    issueProfileSession: jest.fn().mockReturnValue({ token: 'jwt' }),
    resolveSessionProfile: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<AuthService>;

  const authorization = {
    consentContext: jest.fn().mockResolvedValue({ scopes: [] }),
  } as unknown as jest.Mocked<OAuthAuthorizationService>;

  const config = {
    get: (key: string) =>
      ({
        AUTH_COOKIE_NAME: 'access_token',
        OIDC_PAIRWISE_SALT: 'salt',
        FRONTEND_URL: 'http://localhost:3000',
      })[key],
  } as unknown as ConfigService;

  const prisma = {
    profile: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p-1', status: 'ACTIVE' }),
    },
  } as unknown as PrismaService;

  const res = { cookie: jest.fn() } as unknown as Response;

  const controller = new OAuthAuthorizeController(
    authorization,
    interactions,
    auth,
    config,
    prisma,
    new OAuthSandboxService(config),
  );

  return { controller, interactions, auth, authorization, prisma, res };
}

const sandboxInteraction = {
  appId: 'app-1',
  scopes: ['openid', 'profile'],
  sandbox: true,
  profileId: null,
  otpAttempts: 0,
};

const realInteraction = { ...sandboxInteraction, sandbox: false };

describe('send-otp in a sandbox interaction', () => {
  /**
   * The point of the whole feature: a partner gets a code without a phone, and
   * Rabotka sends no WhatsApp message and writes no OTP to Redis.
   */
  it.each([SANDBOX_PHONE, SANDBOX_PHONE_UNVERIFIED])(
    'accepts %s without sending anything',
    async (phone) => {
      const { controller, auth, interactions } = build(sandboxInteraction);

      await expect(controller.sendOtp('int-1', { phone })).resolves.toEqual({
        sent: true,
      });
      expect(auth.sendOtp).not.toHaveBeenCalled();
      expect(interactions.patch).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({ pendingPhone: phone }),
      );
    },
  );

  /**
   * Invariant A at the OTP door. Falling through to `auth.sendOtp` here would
   * let a sandbox app start a login against a real person — and would make it a
   * free "send a WhatsApp message to any number" endpoint besides.
   */
  it('refuses a real number, and sends nothing', async () => {
    const { controller, auth, interactions } = build(sandboxInteraction);

    await expect(
      controller.sendOtp('int-1', { phone: REAL_PHONE }),
    ).resolves.toEqual({ sent: false, reason: 'no_account' });
    expect(auth.sendOtp).not.toHaveBeenCalled();
    expect(interactions.patch).not.toHaveBeenCalled();
  });
});

describe('send-otp in a real interaction', () => {
  /**
   * Invariant B, stated explicitly rather than left to the accident that these
   * numbers happen not to be registered: `profiles.phone` has no format
   * validation, so that accident is one INSERT away from being untrue.
   */
  it.each([SANDBOX_PHONE, SANDBOX_PHONE_UNVERIFIED])(
    'refuses the sandbox number %s without querying',
    async (phone) => {
      const { controller, auth } = build(realInteraction);

      await expect(controller.sendOtp('int-1', { phone })).resolves.toEqual({
        sent: false,
        reason: 'no_account',
      });
      expect(auth.sendOtp).not.toHaveBeenCalled();
    },
  );

  it('still sends a real OTP to a real number', async () => {
    const { controller, auth } = build(realInteraction);

    await expect(
      controller.sendOtp('int-1', { phone: REAL_PHONE }),
    ).resolves.toEqual({ sent: true });
    expect(auth.sendOtp).toHaveBeenCalledWith(REAL_PHONE);
  });

  it('still answers no_account when the real send throws', async () => {
    const { controller, auth } = build(realInteraction);
    (auth.sendOtp as jest.Mock).mockRejectedValue(new Error('404'));

    await expect(
      controller.sendOtp('int-1', { phone: REAL_PHONE }),
    ).resolves.toEqual({ sent: false, reason: 'no_account' });
  });
});

describe('verify-otp in a sandbox interaction', () => {
  const pending = { ...sandboxInteraction, pendingPhone: SANDBOX_PHONE };

  /**
   * Invariant E. No `issueProfileSession` and no cookie: there is no `profiles`
   * row behind this subject, so a session would be a ghost one — and it is also
   * what keeps the sentinel out of the next `/authorize`, since there would be
   * nothing for `resolveSessionProfile` to hand back.
   */
  it('authenticates the sandbox user without minting a session', async () => {
    const { controller, auth, interactions, res } = build(pending);

    await controller.verifyOtp(
      'int-1',
      { phone: SANDBOX_PHONE, otp: SANDBOX_OTP },
      res,
    );

    expect(auth.verifyOtpAndGetProfile).not.toHaveBeenCalled();
    expect(auth.issueProfileSession).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();

    const patch = (interactions.patch as jest.Mock).mock.calls[0][1];
    expect(patch.profileId).toBe('sandbox:verified');
    expect(typeof patch.authTime).toBe('number');
    expect(patch.pendingPhone).toBeUndefined();
    expect(patch.otpAttempts).toBe(0);
  });

  it('resolves the second user to its own subject', async () => {
    const { controller, interactions, res } = build({
      ...sandboxInteraction,
      pendingPhone: SANDBOX_PHONE_UNVERIFIED,
    });

    await controller.verifyOtp(
      'int-1',
      { phone: SANDBOX_PHONE_UNVERIFIED, otp: SANDBOX_OTP },
      res,
    );

    expect((interactions.patch as jest.Mock).mock.calls[0][1].profileId).toBe(
      'sandbox:unverified',
    );
  });

  /**
   * A wrong code behaves exactly as it does on the real path — same error, same
   * interaction burn — so a sandbox app is not distinguishable by its failure
   * behaviour, and the consent screen needs no branch of its own.
   */
  it('rejects a wrong code and counts the attempt', async () => {
    const { controller, interactions, res } = build(pending);

    const error = await expectOAuthError(
      controller.verifyOtp(
        'int-1',
        { phone: SANDBOX_PHONE, otp: '123456' },
        res,
      ),
    );

    expect(error.code).toBe('access_denied');
    expect(interactions.recordFailedOtp).toHaveBeenCalledWith('int-1');
    expect(interactions.patch).not.toHaveBeenCalled();
  });

  /**
   * Invariant A again, on the verify side: even with `pendingPhone` agreeing, a
   * real number in a sandbox interaction must not reach the real verify.
   */
  it('refuses a real number rather than falling through', async () => {
    const { controller, auth, res } = build({
      ...sandboxInteraction,
      pendingPhone: REAL_PHONE,
    });

    const error = await expectOAuthError(
      controller.verifyOtp('int-1', { phone: REAL_PHONE, otp: '123456' }, res),
    );

    expect(error.code).toBe('access_denied');
    expect(auth.verifyOtpAndGetProfile).not.toHaveBeenCalled();
  });

  it('still binds the code to the number this interaction asked about', async () => {
    const { controller, res } = build(pending);

    const error = await expectOAuthError(
      controller.verifyOtp(
        'int-1',
        { phone: SANDBOX_PHONE_UNVERIFIED, otp: SANDBOX_OTP },
        res,
      ),
    );

    expect(error.code).toBe('invalid_request');
  });
});

describe('verify-otp in a real interaction', () => {
  /**
   * Invariant D. The fixed code is not special anywhere outside a sandbox
   * interaction — it goes to the real verify like any other six digits, and
   * fails there.
   */
  it('treats the sandbox code as an ordinary wrong code', async () => {
    const { controller, auth, res } = build({
      ...realInteraction,
      pendingPhone: REAL_PHONE,
    });
    (auth.verifyOtpAndGetProfile as jest.Mock).mockRejectedValue(
      new Error('bad otp'),
    );

    const error = await expectOAuthError(
      controller.verifyOtp(
        'int-1',
        { phone: REAL_PHONE, otp: SANDBOX_OTP },
        res,
      ),
    );

    expect(error.code).toBe('access_denied');
    expect(auth.verifyOtpAndGetProfile).toHaveBeenCalledWith(
      REAL_PHONE,
      SANDBOX_OTP,
    );
  });

  it('still mints a session on a real success', async () => {
    const { controller, auth, res } = build({
      ...realInteraction,
      pendingPhone: REAL_PHONE,
    });

    await controller.verifyOtp(
      'int-1',
      { phone: REAL_PHONE, otp: '654321' },
      res,
    );

    expect(auth.issueProfileSession).toHaveBeenCalledWith('p-1');
    expect(res.cookie).toHaveBeenCalled();
  });
});
