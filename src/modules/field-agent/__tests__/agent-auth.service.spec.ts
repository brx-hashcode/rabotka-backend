import { UnauthorizedException } from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import * as otpStore from '../../auth/otp-store';
import { AgentAuthService } from '../agent-auth.service';

jest.mock('../../auth/otp-store', () => ({
  assertCanSendOtp: jest.fn().mockResolvedValue(undefined),
  consumeOtp: jest.fn().mockResolvedValue(true),
  generateOtp: jest.fn().mockReturnValue('123456'),
  storeOtp: jest.fn().mockResolvedValue(undefined),
}));

const SELF = {
  id: 'agent-1',
  first_name: 'Awa',
  last_name: 'N',
  email: 'awa@example.com',
  phone: '+242060000000',
  avatar_url: null,
  status: AgentStatus.ACTIVE,
  zones: [{ country_code: 'CG', city: 'Brazzaville' }],
};

describe('AgentAuthService', () => {
  let redis: Record<string, jest.Mock>;
  let prisma: { agent: { findUnique: jest.Mock; update: jest.Mock } };
  let jwt: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };
  let mail: { sendMail: jest.Mock };
  let log: { create: jest.Mock };
  let auth: { revokeToken: jest.Mock };
  let service: AgentAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    prisma = {
      agent: {
        findUnique: jest.fn().mockImplementation(({ select }) =>
          Promise.resolve(
            select?.zones
              ? SELF
              : {
                  id: SELF.id,
                  first_name: 'Awa',
                  status: AgentStatus.ACTIVE,
                },
          ),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    jwt = {
      sign: jest.fn().mockReturnValue('signed'),
      verify: jest.fn(),
      decode: jest.fn().mockReturnValue({ exp: Date.now() / 1000 + 3600 }),
    };
    mail = { sendMail: jest.fn().mockResolvedValue({ jobId: '1' }) };
    log = { create: jest.fn().mockResolvedValue(undefined) };
    auth = { revokeToken: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn((_k: string, d?: string) => d) };
    const layout = { wrap: jest.fn().mockResolvedValue('<html/>') };

    service = new AgentAuthService(
      redis as any,
      prisma as any,
      jwt as any,
      config as any,
      mail as any,
      layout as any,
      log as any,
      auth as any,
    );
  });

  describe('sendOtp', () => {
    it('emails a code to an active agent', async () => {
      await expect(service.sendOtp(' AWA@example.com ')).resolves.toEqual({
        success: true,
      });
      expect(otpStore.storeOtp).toHaveBeenCalled();
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'awa@example.com' }),
      );
    });

    it.each([
      ['unknown', null],
      ['suspended', { first_name: 'A', status: AgentStatus.SUSPENDED }],
      ['revoked', { first_name: 'A', status: AgentStatus.REVOKED }],
    ])(
      'answers the same for a %s email, and sends nothing',
      async (_label, row) => {
        prisma.agent.findUnique.mockResolvedValue(row);
        await expect(service.sendOtp('x@example.com')).resolves.toEqual({
          success: true,
        });
        expect(otpStore.storeOtp).not.toHaveBeenCalled();
        expect(mail.sendMail).not.toHaveBeenCalled();
      },
    );

    it('counts the send for every address, so the cap reveals nothing', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await service.sendOtp('stranger@example.com');
      expect(otpStore.assertCanSendOtp).toHaveBeenCalledWith(
        redis,
        expect.stringContaining('stranger@example.com'),
      );
    });
  });

  describe('verifyOtp', () => {
    it('issues an agent token pair and stamps the login', async () => {
      const result = await service.verifyOtp('awa@example.com', '123456');

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'agent-1', type: 'agent' }),
        expect.anything(),
      );
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'agent-1', type: 'agent_refresh' }),
        expect.anything(),
      );
      expect(result.agent.id).toBe('agent-1');
      expect(prisma.agent.update).toHaveBeenCalled();
      expect(log.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AGENT_LOGIN' }),
      );
    });

    it('refuses a wrong code', async () => {
      (otpStore.consumeOtp as jest.Mock).mockResolvedValueOnce(false);
      await expect(
        service.verifyOtp('awa@example.com', '000000'),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('refuses an agent suspended after the code was sent', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        status: AgentStatus.SUSPENDED,
      });
      await expect(
        service.verifyOtp('awa@example.com', '123456'),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwt.sign).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rotates: the old refresh token is spent', async () => {
      jwt.verify.mockReturnValue({
        sub: 'agent-1',
        type: 'agent_refresh',
        jti: 'r1',
      });
      redis.get.mockResolvedValue('agent-1');

      await service.refresh('old');

      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('r1'));
      expect(jwt.sign).toHaveBeenCalledTimes(2);
    });

    it("refuses the mobile app's refresh token", async () => {
      jwt.verify.mockReturnValue({ sub: 'p1', type: 'refresh', jti: 'r1' });
      await expect(service.refresh('mobile')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a refresh token already used', async () => {
      jwt.verify.mockReturnValue({
        sub: 'agent-1',
        type: 'agent_refresh',
        jti: 'r1',
      });
      redis.get.mockResolvedValue(null);
      await expect(service.refresh('replayed')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses to refresh a suspended agent', async () => {
      jwt.verify.mockReturnValue({
        sub: 'agent-1',
        type: 'agent_refresh',
        jti: 'r1',
      });
      redis.get.mockResolvedValue('agent-1');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        status: AgentStatus.SUSPENDED,
      });
      await expect(service.refresh('t')).rejects.toThrow(UnauthorizedException);
    });
  });

  it('logout revokes the access token and drops the refresh token', async () => {
    jwt.decode.mockReturnValue({ jti: 'r9' });
    await service.logout('access', 'refresh');
    expect(auth.revokeToken).toHaveBeenCalledWith('access');
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('r9'));
  });
});
