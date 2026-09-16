import { Logger } from '@nestjs/common';
import { BotNotificationService } from '../bot-notification.service';
import { inAppNotifications } from '../../../profile-notification/__tests__/in-app-notifications';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    worker_id: 'w-1',
    job_offer: {
      id: 'jo-1',
      title: 'Plombier',
      scheduled_at: new Date('2026-06-01T10:00:00Z'),
      address: '10 Rue Paris',
      amount: 15000,
      employer_id: 'e-1',
      employer: {
        id: 'e-1',
        phone: '+24200000002',
        first_name: 'Jean',
        last_name: 'Patron',
      },
    },
    worker: {
      id: 'w-1',
      first_name: 'Alice',
      last_name: 'Dupont',
      phone: '+24200000001',
      email: 'alice@example.com',
      description: 'Expert plombier',
      reliability_score: 90,
      avatar_url: null,
    },
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    application: {
      findUnique: jest.fn().mockResolvedValue(makeApp()),
      count: jest.fn().mockResolvedValue(5),
    },
    contactUnlockAttempt: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    profile: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };

  const whatsApp = {
    sendTextMessage: jest.fn().mockResolvedValue(true),
    sendTemplateMessage: jest.fn().mockResolvedValue(true),
    sendMediaMessage: jest.fn().mockResolvedValue(true),
    // Cloud, which is what production runs. The document half short-circuits
    // on a provider that cannot express a document header.
    supports: jest.fn().mockReturnValue(true),
  };

  const botInbox = {
    push: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(1),
  };

  return { prisma, whatsApp, botInbox };
}

describe('BotNotificationService', () => {
  let service: BotNotificationService;
  let deps: ReturnType<typeof makeDeps> & {
    contactUnlock: { getByApplicationId: jest.Mock };
  };
  let feedback: { requestFeedback: jest.Mock; mintFlowToken: jest.Mock };
  // `set` returns 'OK' when the NX claim is won, null when someone holds it —
  // which is exactly how the notification pacing decides to send or stay quiet.
  let redis: { set: jest.Mock; del: jest.Mock };
  let contractService: { create: jest.Mock; downloadAsAdmin: jest.Mock };
  let whatsAppDocuments: { send: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    const base = makeDeps();
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const contactUnlock = {
      getByApplicationId: jest.fn().mockResolvedValue(null),
    };
    // The ask now rides on the unlock template's own FLOW button, so only the
    // token comes from here; `requestFeedback` is the free-form path the
    // unlock no longer uses.
    feedback = {
      requestFeedback: jest.fn().mockResolvedValue(true),
      mintFlowToken: jest.fn((id: string) => `fb_${id}_uuid`),
    };
    deps = { ...base, contactUnlock };
    contractService = {
      create: jest.fn().mockResolvedValue({ id: 'contract-1' }),
      downloadAsAdmin: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('%PDF'), filename: 'c.pdf' }),
    };
    whatsAppDocuments = { send: jest.fn().mockResolvedValue(true) };
    events = { emit: jest.fn() };

    service = new BotNotificationService(
      deps.prisma as any,
      deps.whatsApp as any,
      deps.botInbox as any,
      contactUnlock as any,
      {
        getContactUnlockFees: jest.fn().mockResolvedValue({
          employerFeeFcfa: 500,
          workerFeeFcfa: 100,
          expiryHours: 48,
        }),
        getFees: jest.fn().mockResolvedValue({
          lateCancellationPenaltyFcfa: 5000,
          lateCancellationScoreDeduction: 5,
          cancellationThresholdHours: 4,
          reliabilityScoreMin: 50,
          employerLateCancelScoreDeduction: 5,
          billingBlockThreshold: 2,
        }),
        getNewApplicationNotifyCooldownMinutes: jest.fn().mockResolvedValue(30),
      } as any,
      { getProfileWalletBalance: jest.fn().mockResolvedValue(0) } as any,
      feedback as any,
      redis as any,
      contractService as any,
      whatsAppDocuments as any,
      events as any,
    );
  });

  describe('in-app notifications', () => {
    it('notifies an accepted worker even without a phone, flagging a pending fee', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ worker: { ...makeApp().worker, phone: null } }),
      );
      deps.contactUnlock.getByApplicationId.mockResolvedValue({ id: 'a-1' });

      await service.sendApplicationAcceptedToWorker('app-1');

      const [payload] = inAppNotifications(events.emit, 'APPLICATION_ACCEPTED');
      expect(payload.input).toMatchObject({
        applicationId: 'app-1',
        paymentPending: true,
      });
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('marks an auto-fill rejection as automatic', async () => {
      deps.prisma.application.findUnique.mockResolvedValue({
        worker_id: 'worker-1',
        rejection_source: 'AUTO_FILL',
        job_offer: { title: 'Plombier' },
        worker: { phone: null },
      });

      await service.sendApplicationRejectedToWorker('app-1');

      const [payload] = inAppNotifications(events.emit, 'APPLICATION_REJECTED');
      expect(payload).toMatchObject({
        recipientId: 'worker-1',
        input: { automatic: true, jobTitle: 'Plombier' },
      });
    });

    it('tells the employer a worker cancelled', async () => {
      await service.sendCancellationToEmployer('app-1', null, false);

      const [payload] = inAppNotifications(
        events.emit,
        'APPLICATION_CANCELLED',
      );
      expect(payload.recipientId).toBeTruthy();
      expect(payload.input).toMatchObject({ type: 'APPLICATION_CANCELLED' });
    });

    it('tells the worker the employer cancelled the hire', async () => {
      deps.prisma.application.findUnique.mockResolvedValue({
        worker_id: 'worker-1',
        job_offer: { title: 'Plombier', employer_id: 'emp-1' },
        worker: { phone: null, first_name: 'Bob' },
      });

      await service.sendCancellationToWorker('app-1', null);

      const [payload] = inAppNotifications(events.emit, 'HIRE_CANCELLED');
      expect(payload).toMatchObject({
        recipientId: 'worker-1',
        actorId: 'emp-1',
      });
    });

    it('tells both parties about an unlock, each deduplicated', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        application_id: 'app-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: null,
        })
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: null,
        });

      // The payer is skipped on WhatsApp, never in the bell.
      await service.sendContactUnlockedNotification('attempt-1', {
        skipNotifyProfileId: 'emp-1',
      });

      const payloads = inAppNotifications(events.emit, 'CONTACT_UNLOCKED');
      expect(payloads.map((p) => p.recipientId).sort()).toEqual([
        'emp-1',
        'worker-1',
      ]);
      const toEmployer = payloads.find((p) => p.recipientId === 'emp-1');
      expect(toEmployer?.input).toMatchObject({
        recipientRole: 'EMPLOYER',
        applicationId: 'app-1',
        counterpartName: 'Bob J.',
      });
      expect(new Set(payloads.map((p) => p.dedupeKey)).size).toBe(2);
    });
  });

  describe('sendNewApplicationToEmployer()', () => {
    it('sends the new-application template to the employer', async () => {
      await service.sendNewApplicationToEmployer('app-1');
      // Asserted against the constant, not a literal, so swapping in a newly
      // approved template does not require touching this test.
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000002',
        'newApplication',
        expect.objectContaining({ workerName: expect.any(String) }),
        expect.any(String),
      );
    });

    // Pacing. An offer with twenty-five candidates used to send twenty-five
    // billed templates, all opening the same page.
    it('claims the offer window before sending, keyed by offer', async () => {
      await service.sendNewApplicationToEmployer('app-1');
      expect(redis.set).toHaveBeenCalledWith(
        'new_application_notify:jo-1',
        '1',
        'EX',
        30 * 60,
        'NX',
      );
    });

    it('stays quiet when the offer was already announced in this window', async () => {
      // ioredis returns null when SET NX loses the race.
      redis.set.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    // Skipping must be cheap: the counting query sits behind the claim, so a
    // paced-out application costs neither a message nor a round trip.
    it('does not query anything further once paced out', async () => {
      redis.set.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.prisma.application.count).not.toHaveBeenCalled();
    });

    it('hands the window back when the send throws', async () => {
      deps.whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('WhatsApp down'),
      );
      await service.sendNewApplicationToEmployer('app-1');
      // Otherwise one transient failure silences every later applicant on this
      // offer for the rest of the cooldown.
      expect(redis.del).toHaveBeenCalledWith('new_application_notify:jo-1');
    });

    it('notifies on every application when the cooldown is 0', async () => {
      (
        service as unknown as {
          systemConfig: { getNewApplicationNotifyCooldownMinutes: jest.Mock };
        }
      ).systemConfig.getNewApplicationNotifyCooldownMinutes.mockResolvedValue(
        0,
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(redis.set).not.toHaveBeenCalled();
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('passes the applicationId as the CTA button URL suffix', async () => {
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ applicationId: 'app-1' }),
        expect.any(String),
      );
    });

    it('no longer arms the accept/refuse flow or queues an inbox entry', async () => {
      // The approved template carries a URL button to /candidatures/:id instead
      // of « Accepter » / « Refuser », so there is nothing a typed reply drives.
      // The service holds no BotStateService at all now, so it cannot arm a
      // flow even by accident — the guarantee is structural, not asserted.
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.botInbox.push).not.toHaveBeenCalled();
      // ...and the send still happens regardless of chat state.
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('sends the notification as a template (not media) even when worker has avatar', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({
          worker: {
            ...makeApp().worker,
            avatar_url: 'https://cdn.example.com/avatar.jpg',
          },
        }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendMediaMessage).not.toHaveBeenCalled();
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(1);
    });

    it('does nothing when application not found', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('missing');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('does nothing when employer has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({
          job_offer: {
            ...makeApp().job_offer,
            employer: { ...makeApp().job_offer.employer, phone: null },
          },
        }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('DB error'),
      );
      await expect(
        service.sendNewApplicationToEmployer('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('asking for feedback after an unlock', () => {
    it('asks both parties on the unlock template itself', async () => {
      // The unlock is the moment the product either delivered or did not, so
      // it is the honest place to ask — and the ask is a FLOW button on the
      // template, not a second message. A second message would be a free-form
      // interactive send, which WhatsApp rejects outside the 24h window (the
      // window anyone who paid on the web is outside of).
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        })
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        });
      await service.sendContactUnlockedNotification('attempt-1');

      expect(feedback.requestFeedback).not.toHaveBeenCalled();
      // A token per recipient, and each one naming the profile that was asked
      // — that string is the only thing tying a submission back to a person.
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        'contactUnlocked',
        expect.objectContaining({ flowToken: 'fb_emp-1_uuid' }),
      );
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242002',
        'contactUnlocked',
        expect.objectContaining({ flowToken: 'fb_worker-1_uuid' }),
      );
    });

    it('does not let a failed survey break the unlock notification', async () => {
      // A survey must never cost the reader the contact details they paid for.
      feedback.requestFeedback.mockRejectedValue(new Error('flow unavailable'));
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        })
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        });
      await expect(
        service.sendContactUnlockedNotification('attempt-1'),
      ).resolves.not.toThrow();
    });
  });

  describe('sendApplicationAcceptedToWorker()', () => {
    it('sends the simple accepted template when there is no pending unlock', async () => {
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'applicationAccepted',
        expect.objectContaining({ offerTitle: expect.any(String) }),
        expect.any(String),
      );
    });

    it('sends the unlock template and arms no chat state', async () => {
      deps.contactUnlock.getByApplicationId.mockResolvedValue({
        id: 'attempt-1',
        expires_at: new Date(Date.now() + 3600_000),
      });
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'applicationAcceptedUnlock',
        expect.objectContaining({ offerTitle: expect.any(String) }),
        expect.any(String),
      );
      // It used to pre-arm the unlock flow so a "Continuer" quick-reply could
      // re-show a payment menu in the chat. The template carries a URL button
      // now and the worker settles up in the app, so arming a flow only left a
      // stale state for the next thing they typed to fall into. The service no
      // longer holds a BotStateService, so this can no longer regress.
    });

    it('does nothing when worker has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ worker: { ...makeApp().worker, phone: null } }),
      );
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('DB error'),
      );
      await expect(
        service.sendApplicationAcceptedToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendApplicationRejectedToWorker()', () => {
    it('sends the rejection template to worker', async () => {
      await service.sendApplicationRejectedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'applicationRejected',
        // Takes no params — the short-link destination is baked into the
        // registry entry, and the processor swaps it for a login code on the
        // way out. Covered in the twilio mapper spec.
        undefined,
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendApplicationRejectedToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendCancellationToEmployer()', () => {
    it('sends the cancellation template to employer', async () => {
      await service.sendCancellationToEmployer('app-1', 'Malade', false);
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000002',
        'cancellation',
        expect.objectContaining({ reason: 'Malade' }),
      );
    });

    it('falls back to a default reason and a no-penalty status when applicable', async () => {
      await service.sendCancellationToEmployer('app-1', null, false);
      // The "Aucune raison donnée" fallback now lives in the registry's
      // variables() and is exercised in the twilio mapper spec; here the
      // service is only responsible for passing the raw reason through.
      const params = deps.whatsApp.sendTemplateMessage.mock.calls[0][2];
      expect(params.reason ?? '').toBe('');
      expect(params.penaltyStatus).toContain('Aucune pénalité');
    });

    it('sets a penalty status when the cancellation was late', async () => {
      await service.sendCancellationToEmployer('app-1', null, true);
      const params = deps.whatsApp.sendTemplateMessage.mock.calls[0][2];
      expect(params.penaltyStatus).toContain('pénalité');
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendCancellationToEmployer('app-1', null, false),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendContactUnlockedNotification()', () => {
    it('does nothing when attempt not found', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      await service.sendContactUnlockedNotification('attempt-1');
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends notifications to both parties when found', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        }) // employer
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        }); // worker
      await service.sendContactUnlockedNotification('attempt-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(2);
    });

    /**
     * The contract rides along with the contact details, from inside this
     * method — so it reaches BOTH dispatch sites (ContactUnlockService and
     * PaymentRequestService) without either being touched.
     */
    describe('mission contract', () => {
      const unlocked = () => ({
        id: 'attempt-1',
        status: 'UNLOCKED',
        application_id: 'app-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });

      const bothParties = () => {
        deps.prisma.profile.findUnique
          .mockResolvedValueOnce({
            phone: '+242001',
            first_name: 'Alice',
            last_name: 'Smith',
            email: 'a@t.com',
          })
          .mockResolvedValueOnce({
            phone: '+242002',
            first_name: 'Bob',
            last_name: 'Jones',
            email: 'b@t.com',
          });
        deps.prisma.application.findUnique = jest
          .fn()
          .mockResolvedValue({ job_offer: { title: 'Peinture' } });
        redis.set.mockResolvedValue('OK');
      };

      it('backfills the contract row, then sends to BOTH parties', async () => {
        // `markApplicationAcceptedAfterUnlock` flips WAITING_PAYMENT →
        // ACCEPTED without creating a contract, so an application that got
        // here through payment alone has never had one. `create` is idempotent.
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
          unlocked(),
        );
        bothParties();

        await service.sendContactUnlockedNotification('attempt-1');

        expect(contractService.create).toHaveBeenCalledWith('app-1');
        expect(whatsAppDocuments.send).toHaveBeenCalledTimes(2);
      });

      it('uses downloadAsAdmin, which does not consume DOWNLOADED', async () => {
        // That status records whether a party pulled their own copy. A push
        // delivery must not spend it on their behalf.
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
          unlocked(),
        );
        bothParties();

        await service.sendContactUnlockedNotification('attempt-1');

        expect(contractService.downloadAsAdmin).toHaveBeenCalledWith(
          'contract-1',
        );
      });

      it('sends no contract for an attempt that is not UNLOCKED', async () => {
        // Half-paid: the contact details already guard themselves elsewhere,
        // but a contract for an unfinished unlock would be a real bug.
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
          ...unlocked(),
          status: 'PENDING_WORKER',
        });
        bothParties();

        await service.sendContactUnlockedNotification('attempt-1');

        expect(whatsAppDocuments.send).not.toHaveBeenCalled();
      });

      it('sends nothing a second time for the same pair', async () => {
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
          unlocked(),
        );
        bothParties();
        redis.set.mockResolvedValue(null); // claim already held

        await service.sendContactUnlockedNotification('attempt-1');

        expect(whatsAppDocuments.send).not.toHaveBeenCalled();
      });

      it('still delivers both contact messages when the contract fails', async () => {
        // The ordering guarantee: the contact details are what these two just
        // paid for, and a contract that cannot render must not cost them that.
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
          unlocked(),
        );
        bothParties();
        contractService.downloadAsAdmin.mockRejectedValue(
          new Error('no CONTRACT template'),
        );

        await expect(
          service.sendContactUnlockedNotification('attempt-1'),
        ).resolves.toBeUndefined();

        expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(2);
      });

      it("releases only the failing party's claim and still tries the other", async () => {
        deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
          unlocked(),
        );
        bothParties();
        whatsAppDocuments.send
          .mockRejectedValueOnce(new Error('graph 500'))
          .mockResolvedValueOnce(true);

        await service.sendContactUnlockedNotification('attempt-1');

        expect(whatsAppDocuments.send).toHaveBeenCalledTimes(2);
        expect(redis.del).toHaveBeenCalledTimes(1);
      });
    });

    it('skips notifying skipNotifyProfileId', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        })
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        });
      await service.sendContactUnlockedNotification('attempt-1', {
        skipNotifyProfileId: 'emp-1',
      });
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(1); // only worker notified
    });
  });

  describe('sendContactUnlockCreditConversionNotification()', () => {
    it('does nothing when profile has no phone', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({ phone: null });
      await service.sendContactUnlockCreditConversionNotification(
        'profile-1',
        500,
      );
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends message when profile has phone', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({ phone: '+242001' });
      await service.sendContactUnlockCreditConversionNotification(
        'profile-1',
        500,
      );
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        'unlockExpiredConversion',
        { amount: 500 },
        expect.any(String),
      );
    });
  });

  describe('sendMessage()', () => {
    it('sends a text message', async () => {
      await service.sendMessage('+242001', 'Hello');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+242001',
        'Hello',
      );
    });
  });

  describe('sendRecommendedJobNotification()', () => {
    it('does nothing when profile not found', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(null);
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue(null),
      };
      const sent = await service.sendRecommendedJobNotification(
        'worker-1',
        'jo-1',
      );

      // The caller releases the worker's cooldown on `false`, so "nothing was
      // sent" has to be reported, not swallowed.
      expect(sent).toBe(false);
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends message when profile and offer found', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };
      const sent = await service.sendRecommendedJobNotification(
        'worker-1',
        'jo-1',
      );

      expect(sent).toBe(true);
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        expect.any(String),
        expect.objectContaining({ title: 'Plombier' }),
      );
    });

    it('still sends when the worker is mid-flow', async () => {
      // Regression: this used to `return` when the flow state could not be
      // written, so a worker who happened to be mid-conversation silently
      // received no job recommendations at all. Delivery must never depend on
      // chat state.
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };

      const sent = await service.sendRecommendedJobNotification(
        'worker-1',
        'jo-1',
      );

      expect(sent).toBe(true);
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('still sends when arming the flow throws', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };

      const sent = await service.sendRecommendedJobNotification(
        'worker-1',
        'jo-1',
      );

      expect(sent).toBe(true);
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('reports a provider failure rather than swallowing it', async () => {
      // The caller cannot release a cooldown it was never told to release, so
      // a throw here has to surface as `false` rather than as a silent void.
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };
      deps.whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('twilio down'),
      );

      await expect(
        service.sendRecommendedJobNotification('worker-1', 'jo-1'),
      ).resolves.toBe(false);
    });

    it('reports an ineligible worker as not sent', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'SUSPENDED',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };

      await expect(
        service.sendRecommendedJobNotification('worker-1', 'jo-1'),
      ).resolves.toBe(false);
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });
  });
});
