import { AuthController } from '../auth.controller';

function makeAuthService() {
  return {
    sendOtp: jest.fn().mockResolvedValue({ success: true }),
    resendOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyOtp: jest.fn().mockResolvedValue({ token: 'jwt-token' }),
    loginWithWhatsAppCode: jest
      .fn()
      .mockResolvedValue({ token: 'wa-jwt', profileId: 'p-1' }),
    sendAdminOtp: jest.fn().mockResolvedValue({ success: true }),
    resendAdminOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyAdminOtp: jest.fn().mockResolvedValue({ token: 'admin-jwt' }),
    getAdminById: jest.fn().mockResolvedValue({
      id: 'u-1',
      email: 'admin@example.com',
      name: 'Admin',
    }),
    revokeToken: jest.fn().mockResolvedValue(undefined),
    updateAdminById: jest.fn().mockResolvedValue({
      id: 'u-1',
      firstName: 'John',
      lastName: 'Doe',
      role: 'ADMIN',
    }),
    initQrSession: jest.fn().mockResolvedValue({
      sessionId: 's-1',
      consumeNonce: 'n-1',
      qrUrl: 'http://qr',
      expiresIn: 300,
    }),
    pollQrSession: jest.fn().mockResolvedValue({ status: 'pending' }),
    unpairPhone: jest.fn().mockResolvedValue(undefined),
    generatePhonePairingOtp: jest
      .fn()
      .mockResolvedValue({ otp: '123456', expiresIn: 300, userId: 'u-1' }),
    verifyPhonePairingOtp: jest.fn().mockResolvedValue({ token: 'phone-tok' }),
    generateTotp: jest
      .fn()
      .mockResolvedValue({ secret: 'sec', otpAuthUrl: 'otpauth://...' }),
    verifyTotp: jest.fn().mockResolvedValue({ success: true }),
    disableTotp: jest.fn().mockResolvedValue({ success: true }),
    consumeQrSession: jest.fn().mockResolvedValue({ token: 'qr-tok' }),
    confirmQrSession: jest.fn().mockResolvedValue({ success: true }),
    setupTotp: jest
      .fn()
      .mockResolvedValue({ secret: 'sec', otpAuthUrl: 'otpauth://...' }),
    enableTotp: jest.fn().mockResolvedValue({ success: true }),
    verifyTotpLogin: jest.fn().mockResolvedValue({ token: 'totp-tok' }),
  };
}

function makeConfigService(env: Record<string, string> = {}) {
  return {
    get: jest
      .fn()
      .mockImplementation((key: string) => env[key] ?? 'test-cookie'),
  };
}

function makeQrGateway() {
  return { emitConfirmed: jest.fn() };
}

function makeWsGateway() {
  return { emitToAdmin: jest.fn() };
}

function makeLogService() {
  return { create: jest.fn().mockResolvedValue(undefined) };
}

function makeRes() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as any;
}

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof makeAuthService>;
  let configService: ReturnType<typeof makeConfigService>;

  beforeEach(() => {
    authService = makeAuthService();
    configService = makeConfigService({ AUTH_COOKIE_NAME: 'auth_token' });
    controller = new AuthController(
      authService as any,
      configService as any,
      makeQrGateway() as any,
      makeWsGateway() as any,
      makeLogService() as any,
    );
  });

  describe('sendOtp()', () => {
    it('delegates to authService.sendOtp and returns success message', async () => {
      const result = await controller.sendOtp({
        emailOrPhone: 'alice@example.com',
      } as any);
      expect(authService.sendOtp).toHaveBeenCalledWith('alice@example.com');
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });
  });

  describe('resendOtp()', () => {
    it('delegates to authService.resendOtp', async () => {
      const result = await controller.resendOtp({
        emailOrPhone: '+242000001',
      } as any);
      expect(authService.resendOtp).toHaveBeenCalledWith('+242000001');
      expect(result.success).toBe(true);
    });
  });

  describe('verifyOtp()', () => {
    it('sets cookie and returns success', async () => {
      const res = makeRes();
      const result = await controller.verifyOtp(
        { emailOrPhone: 'alice@example.com', otp: '123456' } as any,
        res,
      );
      expect(authService.verifyOtp).toHaveBeenCalledWith(
        'alice@example.com',
        '123456',
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'auth_token',
        'jwt-token',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(result.success).toBe(true);
    });

    it('throws when AUTH_COOKIE_NAME not set', async () => {
      configService.get.mockReturnValue(undefined);
      const res = makeRes();
      await expect(
        controller.verifyOtp(
          { emailOrPhone: 'a@b.com', otp: '000000' } as any,
          res,
        ),
      ).rejects.toThrow('AUTH_COOKIE_NAME');
    });
  });

  describe('logout()', () => {
    it('clears cookie and returns success', async () => {
      const res = makeRes();
      const req = { cookies: { auth_token: 'jwt-token' } } as any;
      const result = await controller.logout(req, res);
      expect(res.clearCookie).toHaveBeenCalledWith('auth_token', { path: '/' });
      expect(result.success).toBe(true);
    });
  });

  describe('sendAdminOtp()', () => {
    it('delegates to authService.sendAdminOtp', async () => {
      const result = await controller.sendAdminOtp({
        email: 'admin@example.com',
      } as any);
      expect(authService.sendAdminOtp).toHaveBeenCalledWith(
        'admin@example.com',
      );
      expect(result.success).toBe(true);
    });
  });

  describe('resendAdminOtp()', () => {
    it('delegates to authService.resendAdminOtp', async () => {
      const result = await controller.resendAdminOtp({
        email: 'admin@example.com',
      } as any);
      expect(authService.resendAdminOtp).toHaveBeenCalledWith(
        'admin@example.com',
      );
      expect(result.success).toBe(true);
    });
  });

  describe('verifyAdminOtp()', () => {
    it('sets admin cookie and returns success', async () => {
      const res = makeRes();
      const result = await controller.verifyAdminOtp(
        { email: 'admin@example.com', otp: '654321' } as any,
        res,
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'auth_token',
        'admin-jwt',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('getAdminMe()', () => {
    it('returns admin user info', async () => {
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.getAdminMe(req);
      expect(result.email).toBe('admin@example.com');
    });
  });

  describe('adminLogout()', () => {
    it('clears cookie', async () => {
      const res = makeRes();
      const req = { cookies: {} } as any;
      const result = await controller.adminLogout(req, res);
      expect(res.clearCookie).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('revokes token when cookie present', async () => {
      const res = makeRes();
      const req = { cookies: { auth_token: 'some-jwt' } } as any;
      await controller.adminLogout(req, res);
      expect(authService.revokeToken).toHaveBeenCalledWith('some-jwt');
    });
  });

  describe('verifyAdminOtp() with totpRequired', () => {
    it('returns totpRequired without setting cookie', async () => {
      authService.verifyAdminOtp = jest.fn().mockResolvedValue({
        success: true,
        token: 'pending-tok',
        totpRequired: true,
      });
      const res = makeRes();
      const result = await controller.verifyAdminOtp(
        { email: 'admin@example.com', otp: '123456' } as any,
        res,
      );
      expect(result.totpRequired).toBe(true);
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('updateAdminMe()', () => {
    it('updates admin profile', async () => {
      authService.updateAdminById = jest.fn().mockResolvedValue({
        id: 'u-1',
        email: 'admin@example.com',
        firstName: 'John',
        lastName: 'Doe',
        role: 'ADMIN',
      });
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.updateAdminMe(req, {
        firstName: 'John',
        lastName: 'Doe',
      });
      expect(result.firstName).toBe('John');
    });
  });

  describe('initQrSession()', () => {
    it('returns session data', async () => {
      authService.initQrSession = jest.fn().mockResolvedValue({
        sessionId: 's-1',
        consumeNonce: 'n-1',
        qrUrl: 'http://qr',
        expiresIn: 300,
      });
      const result = await controller.initQrSession();
      expect(result.sessionId).toBe('s-1');
    });
  });

  describe('pollQrSession()', () => {
    it('returns session status', async () => {
      authService.pollQrSession = jest
        .fn()
        .mockResolvedValue({ status: 'pending' });
      const result = await controller.pollQrSession('session-1');
      expect(result.status).toBe('pending');
    });
  });

  describe('unpairPhone()', () => {
    it('unpairs phone and returns success', async () => {
      authService.unpairPhone = jest.fn().mockResolvedValue(undefined);
      const wsGateway = makeWsGateway();
      controller = new AuthController(
        authService as any,
        configService as any,
        makeQrGateway() as any,
        wsGateway as any,
        makeLogService() as any,
      );
      const res = makeRes();
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.unpairPhone(req, res);
      expect(authService.unpairPhone).toHaveBeenCalledWith('u-1');
      expect(res.clearCookie).toHaveBeenCalledWith('admin_phone_token', {
        path: '/',
      });
      expect(wsGateway.emitToAdmin).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('generatePhonePairingOtp()', () => {
    it('delegates to authService and returns otp data', async () => {
      authService.generatePhonePairingOtp = jest
        .fn()
        .mockResolvedValue({ otp: '123456', expiresIn: 300, userId: 'u-1' });
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.generatePhonePairingOtp(req, 'iPhone');
      expect(result.otp).toBe('123456');
    });
  });

  describe('verifyPhonePairingOtp()', () => {
    it('sets phone token cookie and returns success', async () => {
      authService.verifyPhonePairingOtp = jest
        .fn()
        .mockResolvedValue({ token: 'phone-tok' });
      const wsGateway = makeWsGateway();
      controller = new AuthController(
        authService as any,
        configService as any,
        makeQrGateway() as any,
        wsGateway as any,
        makeLogService() as any,
      );
      const res = makeRes();
      const result = await controller.verifyPhonePairingOtp(
        'u-1',
        '123456',
        res,
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'admin_phone_token',
        'phone-tok',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('consumeQrSession()', () => {
    it('returns totpRequired when TOTP needed', async () => {
      authService.consumeQrSession = jest
        .fn()
        .mockResolvedValue({ totpRequired: true, pendingToken: 'pending-tok' });
      const res = makeRes();
      const result = await controller.consumeQrSession('s-1', 'n-1', res);
      expect(result.totpRequired).toBe(true);
      expect(result.pendingToken).toBe('pending-tok');
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('sets session cookie when no TOTP needed', async () => {
      authService.consumeQrSession = jest
        .fn()
        .mockResolvedValue({ token: 'session-tok', totpRequired: false });
      const res = makeRes();
      const result = await controller.consumeQrSession('s-1', 'n-1', res);
      expect(res.cookie).toHaveBeenCalledWith(
        'auth_token',
        'session-tok',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(result.success).toBe(true);
    });

    it('throws when AUTH_COOKIE_NAME not set', async () => {
      authService.consumeQrSession = jest
        .fn()
        .mockResolvedValue({ token: 'tok', totpRequired: false });
      configService.get.mockReturnValue(undefined);
      const res = makeRes();
      await expect(
        controller.consumeQrSession('s-1', 'n-1', res),
      ).rejects.toThrow('AUTH_COOKIE_NAME');
    });
  });

  describe('totpSetup()', () => {
    it('delegates to authService.setupTotp', async () => {
      authService.setupTotp = jest.fn().mockResolvedValue({
        secret: 'SECRET',
        qrDataUrl: 'data:image/png;base64,...',
      });
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.totpSetup(req);
      expect(result.secret).toBe('SECRET');
    });
  });

  describe('totpEnable()', () => {
    it('enables TOTP', async () => {
      authService.enableTotp = jest.fn().mockResolvedValue({ success: true });
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.totpEnable(req, '123456');
      expect(result.success).toBe(true);
    });
  });

  describe('totpDisable()', () => {
    it('disables TOTP', async () => {
      authService.disableTotp = jest.fn().mockResolvedValue({ success: true });
      const req = { user: { userId: 'u-1' } } as any;
      const result = await controller.totpDisable(req, '123456');
      expect(result.success).toBe(true);
    });
  });

  describe('totpLogin()', () => {
    it('verifies TOTP and sets session cookie', async () => {
      authService.verifyTotpLogin = jest
        .fn()
        .mockResolvedValue({ token: 'session-tok' });
      const res = makeRes();
      const result = await controller.totpLogin('pending-tok', '123456', res);
      expect(res.cookie).toHaveBeenCalledWith(
        'auth_token',
        'session-tok',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(result.success).toBe(true);
    });

    it('throws when AUTH_COOKIE_NAME not set', async () => {
      authService.verifyTotpLogin = jest
        .fn()
        .mockResolvedValue({ token: 'tok' });
      configService.get.mockReturnValue(undefined);
      const res = makeRes();
      await expect(
        controller.totpLogin('pending', '123456', res),
      ).rejects.toThrow('AUTH_COOKIE_NAME');
    });
  });

  describe('confirmQrSession()', () => {
    it('throws when no phone token cookie', async () => {
      const req = { cookies: {} } as any;
      await expect(
        controller.confirmQrSession('session-1', req),
      ).rejects.toThrow();
    });

    it('confirms QR session and emits', async () => {
      authService.confirmQrSession = jest
        .fn()
        .mockResolvedValue({ success: true });
      const qrGateway = makeQrGateway();
      controller = new AuthController(
        authService as any,
        configService as any,
        qrGateway as any,
        makeWsGateway() as any,
        makeLogService() as any,
      );
      const req = { cookies: { admin_phone_token: 'phone-tok' } } as any;
      const result = await controller.confirmQrSession('session-1', req);
      expect(result.success).toBe(true);
      expect(qrGateway.emitConfirmed).toHaveBeenCalledWith('session-1');
    });
  });

  describe('whatsappSession()', () => {
    it('exchanges the code for the standard session cookie', async () => {
      const res = makeRes();
      const req = { headers: {}, ip: '10.0.0.1' } as any;

      await controller.whatsappSession({ code: 'code-1' } as any, res, req);

      expect(authService.loginWithWhatsAppCode).toHaveBeenCalledWith('code-1');
      expect(res.cookie).toHaveBeenCalledWith(
        'auth_token',
        'wa-jwt',
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          maxAge: 30 * 24 * 60 * 60 * 1000,
        }),
      );
    });

    it('sets no cookie when the code is rejected', async () => {
      authService.loginWithWhatsAppCode = jest
        .fn()
        .mockRejectedValue(new Error('Lien de connexion invalide ou expiré'));
      const res = makeRes();
      const req = { headers: {}, ip: '10.0.0.1' } as any;

      await expect(
        controller.whatsappSession({ code: 'stale' } as any, res, req),
      ).rejects.toThrow();
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });
});
