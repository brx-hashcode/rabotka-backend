import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminProfileController } from '../admin-profile.controller';

function makeProfileService() {
  return {
    getProfilesForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    getProfileDetailForAdmin: jest.fn().mockResolvedValue({ id: 'p1' }),
    updateProfileByAdmin: jest.fn().mockResolvedValue({ id: 'p1' }),
    verifyProfileKyc: jest.fn().mockResolvedValue({ id: 'p1' }),
    updateProfileStatusByAdmin: jest.fn().mockResolvedValue({ id: 'p1' }),
    requestWhatsAppVerification: jest.fn().mockResolvedValue({ token: 'tok' }),
  };
}

function makeLogService() {
  return {
    getByProfileId: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(undefined),
  };
}

function makePaymentRequestService() {
  return {
    getByProfileId: jest.fn().mockResolvedValue([]),
    manualDecide: jest.fn().mockResolvedValue(undefined),
  };
}

function makePrisma(profile: any = null) {
  return {
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    profile: {
      findUnique: jest.fn().mockResolvedValue(profile),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeWhatsApp() {
  return { sendTextMessage: jest.fn().mockResolvedValue(undefined) };
}

function makeMail() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeWalletService() {
  return {
    getProfileWalletForAdmin: jest
      .fn()
      .mockResolvedValue({ balance: 0, transactions: [] }),
  };
}

function makeController(prismaProfile: any = null) {
  return new AdminProfileController(
    makeProfileService() as any,
    makeLogService() as any,
    makePaymentRequestService() as any,
    makePrisma(prismaProfile) as any,
    makeWhatsApp() as any,
    makeMail() as any,
    makeWalletService() as any,
  );
}

describe('AdminProfileController', () => {
  it('list() calls profileService.getProfilesForAdmin', async () => {
    const ctrl = makeController();
    const result = await ctrl.list({ page: 1, limit: 5 } as any);
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('list() uses defaults when page/limit omitted', async () => {
    const ctrl = makeController();
    await ctrl.list({} as any);
  });

  it('getById() delegates to profileService', async () => {
    const ctrl = makeController();
    const result = await ctrl.getById('p1');
    expect(result).toEqual({ id: 'p1' });
  });

  it('getLogs() delegates to logService', async () => {
    const ctrl = makeController();
    const result = await ctrl.getLogs('p1');
    expect(result).toEqual([]);
  });

  it('getPaymentRequests() delegates to paymentRequestService', async () => {
    const ctrl = makeController();
    const result = await ctrl.getPaymentRequests('p1');
    expect(result).toEqual([]);
  });

  describe('getMessages()', () => {
    it('returns mapped messages', async () => {
      const prisma = makePrisma();
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm1',
          direction: 'INBOUND',
          platform: 'WHATSAPP',
          body: 'hi',
          created_at: new Date(),
          sent_by: null,
        },
        {
          id: 'm2',
          direction: 'OUTBOUND',
          platform: 'WHATSAPP',
          body: 'bye',
          created_at: new Date(),
          sent_by: { first_name: 'A', last_name: 'B' },
        },
      ]);
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        makeLogService() as any,
        makePaymentRequestService() as any,
        prisma as any,
        makeWhatsApp() as any,
        makeMail() as any,
        makeWalletService() as any,
      );
      const result = await ctrl.getMessages('p1');
      expect(result).toHaveLength(2);
      expect(result[0].sentByName).toBeNull();
      expect(result[1].sentByName).toBe('A B');
    });
  });

  describe('sendMessage()', () => {
    it('throws NotFoundException when profile not found', async () => {
      const ctrl = makeController(null);
      await expect(
        ctrl.sendMessage(
          'p1',
          { channel: 'WHATSAPP', message: 'hi' },
          undefined,
          {
            user: { userId: 'u1' },
            headers: {},
            ip: '127.0.0.1',
            get: () => undefined,
          } as any,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when message is empty', async () => {
      const ctrl = makeController({ id: 'p1', phone: '+1234', email: null });
      await expect(
        ctrl.sendMessage(
          'p1',
          { channel: 'WHATSAPP', message: '   ' },
          undefined,
          {
            user: { userId: 'u1' },
            headers: {},
            ip: '127.0.0.1',
            get: () => undefined,
          } as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when WHATSAPP channel but no phone', async () => {
      const ctrl = makeController({ id: 'p1', phone: null, email: null });
      await expect(
        ctrl.sendMessage(
          'p1',
          { channel: 'WHATSAPP', message: 'hello' },
          undefined,
          {
            user: { userId: 'u1' },
            headers: {},
            ip: '127.0.0.1',
            get: () => undefined,
          } as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('sends WhatsApp message', async () => {
      const whatsApp = makeWhatsApp();
      const prisma = makePrisma({ id: 'p1', phone: '+1234', email: null });
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        makeLogService() as any,
        makePaymentRequestService() as any,
        prisma as any,
        whatsApp as any,
        makeMail() as any,
        makeWalletService() as any,
      );
      const result = await ctrl.sendMessage(
        'p1',
        { channel: 'WHATSAPP', message: 'hello' },
        undefined,
        {
          user: { userId: 'u1' },
          headers: {},
          ip: '127.0.0.1',
          get: () => undefined,
        } as any,
      );
      expect(whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+1234',
        expect.stringContaining('hello'),
        'p1',
        'u1',
      );
      expect(result).toEqual({ success: true });
    });

    it('throws BadRequestException when EMAIL channel but no email', async () => {
      const ctrl = makeController({ id: 'p1', phone: null, email: null });
      await expect(
        ctrl.sendMessage(
          'p1',
          { channel: 'EMAIL', message: 'hello' },
          undefined,
          {
            user: { userId: 'u1' },
            headers: {},
            ip: '127.0.0.1',
            get: () => undefined,
          } as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('sends email and saves message', async () => {
      const mail = makeMail();
      const prisma = makePrisma({ id: 'p1', phone: null, email: 'u@e.com' });
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        makeLogService() as any,
        makePaymentRequestService() as any,
        prisma as any,
        makeWhatsApp() as any,
        mail as any,
        makeWalletService() as any,
      );
      const result = await ctrl.sendMessage(
        'p1',
        { channel: 'EMAIL', message: 'hello' },
        undefined,
        {
          user: { userId: 'u1' },
          headers: {},
          ip: '127.0.0.1',
          get: () => undefined,
        } as any,
      );
      expect(mail.sendMail).toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  it('update() calls profileService and logs', async () => {
    const profileService = makeProfileService();
    const logService = makeLogService();
    const ctrl = new AdminProfileController(
      profileService as any,
      logService as any,
      makePaymentRequestService() as any,
      makePrisma() as any,
      makeWhatsApp() as any,
      makeMail() as any,
      makeWalletService() as any,
    );
    const result = await ctrl.update('p1', { first_name: 'Jo' } as any, {
      user: { userId: 'u1' },
    });
    expect(profileService.updateProfileByAdmin).toHaveBeenCalledWith('p1', {
      first_name: 'Jo',
    });
    expect(logService.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'p1' });
  });

  it('verify() calls profileService.verifyProfileKyc and logs', async () => {
    const profileService = makeProfileService();
    const logService = makeLogService();
    const ctrl = new AdminProfileController(
      profileService as any,
      logService as any,
      makePaymentRequestService() as any,
      makePrisma() as any,
      makeWhatsApp() as any,
      makeMail() as any,
      makeWalletService() as any,
    );
    const result = await ctrl.verify(
      'p1',
      { decision: 'VERIFIED' as any, reason: 'approved' },
      [],
      {
        user: { userId: 'u1' },
        headers: {},
        ip: '127.0.0.1',
        get: () => undefined,
      } as any,
    );
    expect(profileService.verifyProfileKyc).toHaveBeenCalled();
    expect(logService.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'p1' });
  });

  it('updateStatus() calls profileService and logs', async () => {
    const profileService = makeProfileService();
    const logService = makeLogService();
    const ctrl = new AdminProfileController(
      profileService as any,
      logService as any,
      makePaymentRequestService() as any,
      makePrisma() as any,
      makeWhatsApp() as any,
      makeMail() as any,
      makeWalletService() as any,
    );
    const result = await ctrl.updateStatus('p1', { status: 'ACTIVE' as any }, {
      user: { userId: 'u1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any);
    expect(profileService.updateProfileStatusByAdmin).toHaveBeenCalledWith(
      'p1',
      'ACTIVE',
    );
    expect(logService.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'p1' });
  });

  it('sendVerificationLink() delegates to profileService', async () => {
    const ctrl = makeController();
    const result = await ctrl.sendVerificationLink('p1', {
      user: { userId: 'u1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any);
    expect(result).toEqual({ token: 'tok' });
  });
});
