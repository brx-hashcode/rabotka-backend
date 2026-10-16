import { Test, TestingModule } from '@nestjs/testing';
import { NotificationDispatcher } from '../notification-dispatcher.service';
import { BotPauseService } from '../../bot/services/bot-pause.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../../auth/whatsapp-login-link.service';
import { SystemConfigService } from '../../system-config/system-config.service';

const PHONE = '+24200000001';
const PROFILE_ID = 'profile-uuid-1';

const template = {
  key: 'applicationRejected' as const,
  params: undefined,
};

const freeForm = {
  body: 'Candidature non retenue',
  buttonText: 'Voir les offres',
  path: 'recherche-offres',
};

describe('NotificationDispatcher', () => {
  let dispatcher: NotificationDispatcher;
  const botPause = { isPaused: jest.fn() };
  let whatsApp: {
    sendInteractiveCta: jest.Mock;
    sendTemplateMessage: jest.Mock;
    isServiceWindowOpen: jest.Mock;
    openServiceWindows: jest.Mock;
  };
  let loginLink: { shortLink: jest.Mock };
  let systemConfig: { prefersFreeForm: jest.Mock; get: jest.Mock };
  let module: TestingModule;

  beforeEach(async () => {
    // Reset per test, or the paused case leaks `true` into everything after it.
    botPause.isPaused.mockResolvedValue(false);
    whatsApp = {
      sendInteractiveCta: jest.fn().mockResolvedValue(true),
      sendTemplateMessage: jest.fn().mockResolvedValue(true),
      isServiceWindowOpen: jest
        .fn()
        .mockResolvedValue({ open: true, lastInboundAt: new Date() }),
      openServiceWindows: jest.fn().mockResolvedValue(new Set([PROFILE_ID])),
    };
    loginLink = {
      shortLink: jest.fn().mockResolvedValue('https://rabotka.work/s/ABC123'),
    };
    // Every notification group switched on, unless a test says otherwise.
    systemConfig = {
      prefersFreeForm: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue('true'),
    };

    module = await Test.createTestingModule({
      providers: [
        NotificationDispatcher,
        { provide: WhatsAppService, useValue: whatsApp },
        { provide: WhatsAppLoginLinkService, useValue: loginLink },
        { provide: SystemConfigService, useValue: systemConfig },
        // Not paused by default: every test below asserts what the dispatcher
        // SENDS, and a paused profile is sent nothing at all.
        { provide: BotPauseService, useValue: botPause },
      ],
    }).compile();

    dispatcher = module.get(NotificationDispatcher);
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllMocks();
  });

  describe('per-type switch', () => {
    it('sends nothing when the group is switched off', async () => {
      systemConfig.get.mockResolvedValue('false');

      const result = await dispatcher.send({
        phone: PHONE,
        profileId: PROFILE_ID,
        template,
        freeForm,
      });

      expect(result).toEqual({ mode: 'TEMPLATE', sent: false });
      expect(systemConfig.get).toHaveBeenCalledWith(
        'whatsapp.notify.application_rejected',
        'false',
      );
      expect(whatsApp.sendInteractiveCta).not.toHaveBeenCalled();
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('falls back to the group default when the key was never set', async () => {
      systemConfig.get.mockImplementation((_key: string, fallback: string) =>
        Promise.resolve(fallback),
      );

      await expect(dispatcher.allows('new_application')).resolves.toBe(true);
      await expect(dispatcher.allows('mission_reminders')).resolves.toBe(false);
    });

    it('never gates a template outside the groups', async () => {
      systemConfig.get.mockResolvedValue('false');

      const result = await dispatcher.send({
        phone: PHONE,
        profileId: PROFILE_ID,
        template: { key: 'accountActivatedWorker', params: undefined } as never,
      });

      expect(result.sent).toBe(true);
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });
  });

  it('sends free-form inside the window, and pays for no template', async () => {
    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    expect(result).toEqual({ mode: 'FREE_FORM', sent: true });
    expect(whatsApp.sendInteractiveCta).toHaveBeenCalledWith(
      PHONE,
      expect.objectContaining({
        body: freeForm.body,
        buttonText: freeForm.buttonText,
        url: 'https://rabotka.work/s/ABC123',
        profileId: PROFILE_ID,
      }),
    );
    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  /**
   * The half that suppressing the bot's REPLIES alone would have missed.
   *
   * Every scheduled message — the reminder processor, BotNotificationService —
   * dispatches through here. A mission reminder landing while an admin is
   * mid-handover means the admin is talking over a robot, which is the whole
   * thing the toggle exists to stop.
   */
  it('sends nothing at all while the bot is paused for that profile', async () => {
    botPause.isPaused.mockResolvedValue(true);

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    expect(result).toEqual({ mode: 'TEMPLATE', sent: false });
    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(whatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('sends the template outside the window', async () => {
    whatsApp.isServiceWindowOpen.mockResolvedValue({
      open: false,
      lastInboundAt: null,
    });

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    expect(result).toEqual({ mode: 'TEMPLATE', sent: true });
    expect(whatsApp.sendInteractiveCta).not.toHaveBeenCalled();
    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      PHONE,
      template.key,
      undefined,
      PROFILE_ID,
      undefined,
    );
  });

  it('trusts a window verdict the caller already has, without re-reading it', async () => {
    // What a fan-out does: one batched read for everyone, then a decision per
    // recipient. A second read here would restore the per-recipient round trip
    // the whole column exists to remove.
    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
      windowOpen: false,
    });

    expect(whatsApp.isServiceWindowOpen).not.toHaveBeenCalled();
    expect(result.mode).toBe('TEMPLATE');
  });

  it('sends the template when the config key is off', async () => {
    systemConfig.prefersFreeForm.mockResolvedValue(false);

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    // The kill switch has to reach every sender, or it is not a kill switch.
    expect(result.mode).toBe('TEMPLATE');
    expect(whatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('sends the template when no login code can be minted', async () => {
    loginLink.shortLink.mockResolvedValue(null);

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    // A free message whose button leads nowhere is worse than a billed one
    // that works: the template path mints its own link downstream.
    expect(result.mode).toBe('TEMPLATE');
  });

  it('falls back to the template when the free-form send is refused', async () => {
    whatsApp.sendInteractiveCta.mockResolvedValue(false);

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    expect(result).toEqual({ mode: 'TEMPLATE', sent: true });
    expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
  });

  it('falls back to the template when the free-form send throws', async () => {
    whatsApp.sendInteractiveCta.mockRejectedValue(new Error('131047'));

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    // 131047 is "outside the window" — the case this service is meant to
    // predict. Predicting it wrong must still deliver the message.
    expect(result).toEqual({ mode: 'TEMPLATE', sent: true });
  });

  it('sends the template when the caller gave no free-form rendering', async () => {
    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
    });

    expect(result.mode).toBe('TEMPLATE');
    expect(loginLink.shortLink).not.toHaveBeenCalled();
  });

  it('sends the template when there is no profile to mint against', async () => {
    const result = await dispatcher.send({ phone: PHONE, template, freeForm });

    // OTP and activation sends reach numbers with no profile at all.
    expect(result.mode).toBe('TEMPLATE');
    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      PHONE,
      template.key,
      undefined,
      undefined,
      undefined,
    );
  });

  it('reports a failed template send as not sent', async () => {
    whatsApp.sendTemplateMessage.mockResolvedValue(false);
    whatsApp.isServiceWindowOpen.mockResolvedValue({
      open: false,
      lastInboundAt: null,
    });

    const result = await dispatcher.send({
      phone: PHONE,
      profileId: PROFILE_ID,
      template,
      freeForm,
    });

    // Callers release cooldown claims on a false; swallowing it here would
    // silence a worker over a message they never received.
    expect(result).toEqual({ mode: 'TEMPLATE', sent: false });
  });
});
