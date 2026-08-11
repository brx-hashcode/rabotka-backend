import { WhatsAppFeedbackService } from '../whatsapp-feedback.service';
import type { InboundEvent } from '../../contracts';

/**
 * The flow token is the ONLY thing tying a submitted Flow back to the person
 * who was asked — the reply carries no profile and the sender's number is not
 * on it either. Since the unlock templates moved the ask onto a FLOW button,
 * the token is minted at template-send time and parsed here on the way back,
 * so the two halves have to be tested against each other rather than
 * separately.
 */
describe('WhatsAppFeedbackService', () => {
  const PROFILE = '11111111-2222-3333-4444-555555555555';

  let prisma: { feedback: { create: jest.Mock } };
  let whatsApp: {
    isServiceWindowOpen: jest.Mock;
    supports: jest.Mock;
    sendTextMessage: jest.Mock;
    sendFeedbackFlow: jest.Mock;
  };
  let service: WhatsAppFeedbackService;

  beforeEach(() => {
    prisma = { feedback: { create: jest.fn().mockResolvedValue({}) } };
    whatsApp = {
      isServiceWindowOpen: jest.fn().mockResolvedValue({ open: true }),
      supports: jest.fn().mockReturnValue(true),
      sendTextMessage: jest.fn().mockResolvedValue(true),
      sendFeedbackFlow: jest.fn().mockResolvedValue(true),
    };
    service = new WhatsAppFeedbackService(prisma as any, whatsApp as any);
  });

  const submission = (
    flowToken: string | undefined,
    answers: Record<string, unknown> = { score: 4, comment: 'Très bien' },
  ) =>
    ({
      kind: 'message',
      content: { type: 'flow_reply', flowToken, answers },
    }) as unknown as Extract<InboundEvent, { kind: 'message' }>;

  describe('mintFlowToken', () => {
    it('produces a token that resolves back to the profile that was asked', async () => {
      // The round trip. A format change on either side silently detaches every
      // submission from its author, and nothing else would notice.
      await service.handleSubmission(submission(service.mintFlowToken(PROFILE)));

      expect(prisma.feedback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ profile_id: PROFILE, score: 4 }),
      });
    });

    it('is unique per ask, so two reveals to one profile cannot collide', () => {
      expect(service.mintFlowToken(PROFILE)).not.toBe(
        service.mintFlowToken(PROFILE),
      );
    });
  });

  describe('handleSubmission', () => {
    it('records the comment when there is one', async () => {
      await service.handleSubmission(
        submission(service.mintFlowToken(PROFILE), {
          score: 5,
          comment: '  Rapide  ',
        }),
      );
      expect(prisma.feedback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ score: 5, comment: 'Rapide' }),
      });
    });

    it('stores a blank comment as null rather than an empty string', async () => {
      await service.handleSubmission(
        submission(service.mintFlowToken(PROFILE), { score: 3, comment: '   ' }),
      );
      expect(prisma.feedback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ comment: null }),
      });
    });

    it.each([
      ['no token at all', undefined],
      ['a token from somewhere else', 'wa_12345'],
      // The reason `profileIdFrom` validates the uuid: a merely non-empty id
      // reaches the driver and comes back as `invalid input syntax for type
      // uuid` — a stack trace where a one-line warning belongs.
      ['a token whose profile is not a uuid', 'fb_not-a-uuid_abc'],
    ])('drops a submission with %s', async (_label, token) => {
      await service.handleSubmission(submission(token));
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });

    it.each([0, 6, 2.5, Number.NaN])(
      'drops an out-of-range score (%s)',
      async (score) => {
        await service.handleSubmission(
          submission(service.mintFlowToken(PROFILE), { score }),
        );
        expect(prisma.feedback.create).not.toHaveBeenCalled();
      },
    );

    it('swallows the duplicate a webhook retry produces', async () => {
      // Meta retries anything that is not a 2xx, and the unique index on
      // flow_token is what makes that harmless — but only if it does not throw
      // back onto the webhook path and cause yet another retry.
      prisma.feedback.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.handleSubmission(submission(service.mintFlowToken(PROFILE))),
      ).resolves.toBeUndefined();
    });

    it('never throws on a database failure', async () => {
      prisma.feedback.create.mockRejectedValue(new Error('connection lost'));
      await expect(
        service.handleSubmission(submission(service.mintFlowToken(PROFILE))),
      ).resolves.toBeUndefined();
    });

    it('ignores an inbound event that is not a flow reply', async () => {
      await service.handleSubmission({
        kind: 'message',
        content: { type: 'text', text: 'bonjour' },
      } as unknown as Extract<InboundEvent, { kind: 'message' }>);
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });
  });

  describe('requestFeedback — the free-form path the unlock no longer uses', () => {
    it('falls back to the web form outside the 24h window', async () => {
      // A Flow sent outside the window is rejected (131047). This path is still
      // reachable from anywhere that asks without a template to hang the button
      // on.
      whatsApp.isServiceWindowOpen.mockResolvedValue({ open: false });
      await service.requestFeedback('+242060000000', PROFILE);

      expect(whatsApp.sendFeedbackFlow).not.toHaveBeenCalled();
      expect(whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+242060000000',
        expect.stringContaining('/leave-note'),
        PROFILE,
      );
    });

    it('sends a Flow whose token resolves back to the profile', async () => {
      process.env.WHATSAPP_FEEDBACK_FLOW_ID = 'flow-1';
      await service.requestFeedback('+242060000000', PROFILE);

      const token = whatsApp.sendFeedbackFlow.mock.calls[0][1].flowToken;
      await service.handleSubmission(submission(token));
      expect(prisma.feedback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ profile_id: PROFILE }),
      });
    });
  });
});
