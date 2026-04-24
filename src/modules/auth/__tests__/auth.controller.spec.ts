import { AuthController } from '../auth.controller';

function makeAuthService() {
  return {
    sendOtp: jest.fn().mockResolvedValue({ success: true }),
    resendOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyOtp: jest.fn().mockResolvedValue({ token: 'jwt-token' }),
    sendAdminOtp: jest.fn().mockResolvedValue({ success: true }),
    resendAdminOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyAdminOtp: jest.fn().mockResolvedValue({ token: 'admin-jwt' }),
    getAdminById: jest.fn().mockResolvedValue({ id: 'u-1', email: 'admin@example.com', name: 'Admin' }),
    revokeToken: jest.fn().mockResolvedValue(undefined),
  };
}

function makeConfigService(env: Record<string, string> = {}) {
  return {
    get: jest.fn().mockImplementation((key: string) => env[key] ?? 'test-cookie'),
  };
}

function makeQrGateway() {
  return { emitConfirmed: jest.fn() };
}

function makeWsGateway() {
  return { emitToAdmin: jest.fn() };
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
    controller = new AuthController(authService as any, configService as any, makeQrGateway() as any, makeWsGateway() as any);
  });

  describe('sendOtp()', () => {
    it('delegates to authService.sendOtp and returns success message', async () => {
      const result = await controller.sendOtp({ emailOrPhone: 'alice@example.com' } as any);
      expect(authService.sendOtp).toHaveBeenCalledWith('alice@example.com');
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });
  });

  describe('resendOtp()', () => {
    it('delegates to authService.resendOtp', async () => {
      const result = await controller.resendOtp({ emailOrPhone: '+242000001' } as any);
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
      expect(authService.verifyOtp).toHaveBeenCalledWith('alice@example.com', '123456');
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
        controller.verifyOtp({ emailOrPhone: 'a@b.com', otp: '000000' } as any, res),
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
      const result = await controller.sendAdminOtp({ email: 'admin@example.com' } as any);
      expect(authService.sendAdminOtp).toHaveBeenCalledWith('admin@example.com');
      expect(result.success).toBe(true);
    });
  });

  describe('resendAdminOtp()', () => {
    it('delegates to authService.resendAdminOtp', async () => {
      const result = await controller.resendAdminOtp({ email: 'admin@example.com' } as any);
      expect(authService.resendAdminOtp).toHaveBeenCalledWith('admin@example.com');
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
  });
});
