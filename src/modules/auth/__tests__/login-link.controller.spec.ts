import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { LoginLinkController } from '../login-link.controller';
import { AuthService } from '../auth.service';
import { LogService } from '../../log/log.service';

const FRONTEND = 'https://rabotka.work';
const VALID_CODE = 'a'.repeat(43);

describe('LoginLinkController', () => {
  let controller: LoginLinkController;
  let authService: {
    loginWithWhatsAppCode: jest.Mock;
    resolveSessionProfile: jest.Mock;
  };
  let res: { cookie: jest.Mock; redirect: jest.Mock };
  let req: { headers: object; ip: string; cookies: Record<string, string> };

  /** A request carrying whatever the browser would send back. */
  const withCookie = (token?: string) =>
    ({ ...req, cookies: token ? { access_token: token } : {} }) as never;

  beforeEach(() => {
    authService = {
      loginWithWhatsAppCode: jest.fn().mockResolvedValue({
        token: 'jwt-token',
        profileId: 'p-1',
        path: 'applications/42',
      }),
      resolveSessionProfile: jest.fn().mockResolvedValue(null),
    };
    res = { cookie: jest.fn(), redirect: jest.fn() };
    req = { headers: {}, ip: '10.0.0.1', cookies: {} };

    controller = new LoginLinkController(
      authService as unknown as AuthService,
      {
        get: jest.fn((key: string) =>
          key === 'AUTH_COOKIE_NAME' ? 'access_token' : FRONTEND,
        ),
      } as unknown as ConfigService,
      { create: jest.fn().mockResolvedValue(undefined) } as unknown as LogService,
    );
  });

  it('sets the session cookie and lands on the stored destination', async () => {
    await controller.open(VALID_CODE, res as never, withCookie());

    expect(authService.loginWithWhatsAppCode).toHaveBeenCalledWith(VALID_CODE);
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'jwt-token',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/applications/42`);
  });

  it('gives a 30-day session — the WebView keeps nothing between visits', async () => {
    await controller.open(VALID_CODE, res as never, withCookie());

    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'jwt-token',
      expect.objectContaining({ maxAge: 30 * 24 * 60 * 60 * 1000 }),
    );
  });

  it('falls back to the login screen when the code is dead', async () => {
    // Already used, expired or suspended: the tap must still reach something
    // usable, never an error page.
    authService.loginWithWhatsAppCode.mockRejectedValue(
      new UnauthorizedException(),
    );

    await controller.open(VALID_CODE, res as never, withCookie());

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/login?redirect=${encodeURIComponent('/home')}`,
    );
  });

  describe('when the code is dead but the session it bought is not', () => {
    // Codes are single-use, so every re-tap of an older WhatsApp message lands
    // here. Sending those users to /login made the app flash the phone form and
    // then redirect straight back into itself.
    beforeEach(() => {
      authService.loginWithWhatsAppCode.mockRejectedValue(
        new UnauthorizedException(),
      );
      authService.resolveSessionProfile.mockResolvedValue('p-1');
    });

    it('lands in the app instead of bouncing through /login', async () => {
      await controller.open(VALID_CODE, res as never, withCookie('live-jwt'));

      expect(authService.resolveSessionProfile).toHaveBeenCalledWith(
        'live-jwt',
      );
      expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/home`);
    });

    it('leaves the working session alone', async () => {
      await controller.open(VALID_CODE, res as never, withCookie('live-jwt'));

      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('does the same for a segment that was never a code', async () => {
      // Pending-activation users receive `…/s/profile` — a destination, not a
      // code — and they may already be signed in too.
      await controller.open('profile', res as never, withCookie('live-jwt'));

      expect(authService.loginWithWhatsAppCode).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/home`);
    });
  });

  it('still shows the login screen when the cookie is dead too', async () => {
    authService.loginWithWhatsAppCode.mockRejectedValue(
      new UnauthorizedException(),
    );
    authService.resolveSessionProfile.mockResolvedValue(null);

    await controller.open(VALID_CODE, res as never, withCookie('expired-jwt'));

    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/login?redirect=${encodeURIComponent('/home')}`,
    );
  });

  it.each(['../etc/passwd', 'short', '', 'has space'])(
    'never hands %p to the exchange',
    async (code) => {
      await controller.open(code, res as never, withCookie());

      expect(authService.loginWithWhatsAppCode).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('/login?redirect='),
      );
    },
  );
});
