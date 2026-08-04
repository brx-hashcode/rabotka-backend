import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { LoginLinkController } from '../login-link.controller';
import { AuthService } from '../auth.service';
import { LogService } from '../../log/log.service';

const FRONTEND = 'https://rabotka.work';
const VALID_CODE = 'a'.repeat(43);

describe('LoginLinkController', () => {
  let controller: LoginLinkController;
  let authService: { loginWithWhatsAppCode: jest.Mock };
  let res: { cookie: jest.Mock; redirect: jest.Mock };
  const req = { headers: {}, ip: '10.0.0.1' } as never;

  beforeEach(() => {
    authService = {
      loginWithWhatsAppCode: jest.fn().mockResolvedValue({
        token: 'jwt-token',
        profileId: 'p-1',
        path: 'applications/42',
      }),
    };
    res = { cookie: jest.fn(), redirect: jest.fn() };

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
    await controller.open(VALID_CODE, res as never, req);

    expect(authService.loginWithWhatsAppCode).toHaveBeenCalledWith(VALID_CODE);
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'jwt-token',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/applications/42`);
  });

  it('gives a 30-day session — the WebView keeps nothing between visits', async () => {
    await controller.open(VALID_CODE, res as never, req);

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

    await controller.open(VALID_CODE, res as never, req);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/login?redirect=${encodeURIComponent('/home')}`,
    );
  });

  it.each(['../etc/passwd', 'short', '', 'has space'])(
    'never hands %p to the exchange',
    async (code) => {
      await controller.open(code, res as never, req);

      expect(authService.loginWithWhatsAppCode).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('/login?redirect='),
      );
    },
  );
});
