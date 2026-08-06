import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  return {
    sendTextMessage: jest.fn().mockResolvedValue(undefined),
    sendTemplateMessage: jest.fn().mockResolvedValue(true),
    isServiceWindowOpen: jest
      .fn()
      .mockResolvedValue({ open: true, lastInboundAt: new Date() }),
    sendAdminMessage: jest
      .fn()
      .mockResolvedValue({ mode: 'FREE_FORM', sent: true }),
  };
}

function makeMail() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeLayout() {
  return {
    wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)),
  };
}

function makeWalletService() {
  return {
    getProfileWalletForAdmin: jest
      .fn()
      .mockResolvedValue({ balance: 0, transactions: [] }),
  };
}

function makePortfolioService() {
  return {
    listOwn: jest.fn().mockResolvedValue([{ id: 'item1', images: [] }]),
    updateItem: jest.fn().mockResolvedValue({ id: 'item1', title: 'new' }),
    deleteItem: jest.fn().mockResolvedValue(undefined),
    removeImage: jest.fn().mockResolvedValue(undefined),
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
    makeLayout() as any,
    makeWalletService() as any,
    makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
        makeLayout() as any,
        makeWalletService() as any,
        makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
        makeLayout() as any,
        makeWalletService() as any,
        makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
      expect(whatsApp.sendAdminMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '+1234',
          profileId: 'p1',
          message: 'hello',
          adminUserId: 'u1',
        }),
      );
      // sendAdminMessage persists the OUTBOUND message itself; the controller
      // must NOT create a second one (that caused duplicate WhatsApp bubbles).
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, deliveryMode: 'FREE_FORM' });
    });

    it('reports the template mode when the 24h window has closed', async () => {
      const whatsApp = makeWhatsApp();
      whatsApp.sendAdminMessage.mockResolvedValue({
        mode: 'TEMPLATE',
        sent: true,
      });
      const prisma = makePrisma({ id: 'p1', phone: '+1234', email: null });
      const logService = makeLogService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        logService as any,
        makePaymentRequestService() as any,
        prisma as any,
        whatsApp as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        makePortfolioService() as any,
        { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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

      expect(result).toEqual({ success: true, deliveryMode: 'TEMPLATE' });
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            deliveryMode: 'TEMPLATE',
            success: true,
          }),
        }),
      );
    });

    it('surfaces a failed WhatsApp delivery as 503, and still audit-logs it', async () => {
      const whatsApp = makeWhatsApp();
      whatsApp.sendAdminMessage.mockResolvedValue({
        mode: 'TEMPLATE',
        sent: false,
        error: '[Twilio 63016] outside the 24h window — message failed',
      });
      const prisma = makePrisma({ id: 'p1', phone: '+1234', email: null });
      const logService = makeLogService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        logService as any,
        makePaymentRequestService() as any,
        prisma as any,
        whatsApp as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        makePortfolioService() as any,
        { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
      );

      // This used to return { success: true } and the message simply vanished.
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
      ).rejects.toThrow(ServiceUnavailableException);

      // Logged before the throw: a message that never reached the profile is
      // exactly the event you want on the timeline.
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            success: false,
            failureReason: expect.stringContaining('63016'),
          }),
        }),
      );
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
        makeLayout() as any,
        makeWalletService() as any,
        makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
      // deliveryMode is null for email — it has no 24h service window.
      expect(result).toEqual({ success: true, deliveryMode: null });
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
      makeLayout() as any,
      makeWalletService() as any,
      makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
      makeLayout() as any,
      makeWalletService() as any,
      makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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
      makeLayout() as any,
      makeWalletService() as any,
      makePortfolioService() as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
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

  describe('portfolio (admin)', () => {
    const adminReq = { user: { userId: 'u1' } } as any;

    it('getPortfolio() delegates to portfolioService.listOwn with the profile id', async () => {
      const portfolio = makePortfolioService();
      const logService = makeLogService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        logService as any,
        makePaymentRequestService() as any,
        makePrisma() as any,
        makeWhatsApp() as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        portfolio as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
      const result = await ctrl.getPortfolio('worker-1');
      expect(portfolio.listOwn).toHaveBeenCalledWith('worker-1');
      expect(result).toEqual([{ id: 'item1', images: [] }]);
    });

    it('updatePortfolioItem() delegates with (profileId, itemId, dto) and audit-logs', async () => {
      const portfolio = makePortfolioService();
      const logService = makeLogService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        logService as any,
        makePaymentRequestService() as any,
        makePrisma() as any,
        makeWhatsApp() as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        portfolio as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
      const dto = { title: 'new' };
      await ctrl.updatePortfolioItem('worker-1', 'item1', dto as any, adminReq);
      expect(portfolio.updateItem).toHaveBeenCalledWith(
        'worker-1',
        'item1',
        dto,
      );
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PORTFOLIO_ITEM_UPDATED',
          entityId: 'item1',
          profileId: 'worker-1',
        }),
      );
    });

    it('deletePortfolioItem() delegates and returns success', async () => {
      const portfolio = makePortfolioService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        makeLogService() as any,
        makePaymentRequestService() as any,
        makePrisma() as any,
        makeWhatsApp() as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        portfolio as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
      const result = await ctrl.deletePortfolioItem(
        'worker-1',
        'item1',
        adminReq,
      );
      expect(portfolio.deleteItem).toHaveBeenCalledWith('worker-1', 'item1');
      expect(result).toEqual({ success: true });
    });

    it('deletePortfolioImage() delegates to removeImage(profileId, itemId, imageId)', async () => {
      const portfolio = makePortfolioService();
      const ctrl = new AdminProfileController(
        makeProfileService() as any,
        makeLogService() as any,
        makePaymentRequestService() as any,
        makePrisma() as any,
        makeWhatsApp() as any,
        makeMail() as any,
        makeLayout() as any,
        makeWalletService() as any,
        portfolio as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
      const result = await ctrl.deletePortfolioImage(
        'worker-1',
        'item1',
        'img1',
        adminReq,
      );
      expect(portfolio.removeImage).toHaveBeenCalledWith(
        'worker-1',
        'item1',
        'img1',
      );
      expect(result).toEqual({ success: true });
    });
  });
});
