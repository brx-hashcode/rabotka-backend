import { WhatsappDeliveryStatus } from '@prisma/client';
import {
  describeInbound,
  WhatsappMessageLogService,
} from '../whatsapp-message-log.service';
import { WhatsappError, type InboundEvent } from '../../contracts';

/**
 * The delivery log's two jobs: never break a send, and never walk a row
 * backwards. Both are easy to regress and neither shows up in manual testing —
 * a lost bookkeeping write is silent, and out-of-order webhooks only arrive
 * under the load you cannot reproduce locally.
 */

type StatusEvent = Extract<InboundEvent, { kind: 'status' }>;

function makePrisma(
  row: Record<string, unknown> | null = null,
  profile: { id: string } | null = null,
) {
  return {
    whatsappMessage: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(row),
    },
    profile: {
      findFirst: jest.fn().mockResolvedValue(profile),
    },
    whatsappContact: {
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma> | undefined) {
  const service = new WhatsappMessageLogService(prisma as never);
  // The service logs its own swallowed failures; the assertions below are
  // about behaviour, and a screenful of expected warnings hides real ones.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  return service;
}

function status(over: Partial<StatusEvent> = {}): StatusEvent {
  return {
    kind: 'status',
    providerMessageId: 'wamid.1',
    status: 'delivered',
    timestamp: new Date('2026-08-17T10:00:00Z'),
    provider: 'cloud',
    ...over,
  } as StatusEvent;
}

function existingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    status: WhatsappDeliveryStatus.SENT,
    provider_message_id: 'wamid.1',
    sent_at: new Date('2026-08-17T09:59:00Z'),
    delivered_at: null,
    read_at: null,
    failed_at: null,
    ...over,
  };
}

describe('WhatsappMessageLogService', () => {
  describe('begin()', () => {
    it('opens a QUEUED row and returns its id for the callback echo', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      const id = await service.begin('+242069917686', {
        kind: 'template',
        templateKey: 'kyc',
        bodyPreview: 'Votre KYC est validé',
        profileId: 'profile-1',
      });

      expect(id).toBe('row-1');
      expect(prisma.whatsappMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            to_phone: '+242069917686',
            kind: 'template',
            template_key: 'kyc',
            status: WhatsappDeliveryStatus.QUEUED,
            profile_id: 'profile-1',
          }),
        }),
      );
    });

    it('falls back to the profile owning the number when none is named', async () => {
      // Most senders — every bot reply — know the number they are answering
      // and not the row behind it. Without this the back office showed "no
      // profile" against perfectly ordinary registered users.
      const prisma = makePrisma(null, { id: 'profile-9' });
      const service = makeService(prisma);

      await service.begin('+242069917686', {
        kind: 'template',
        templateKey: 'welcomePlatform',
        bodyPreview: '[TPL:welcomePlatform]',
      });

      const data = prisma.whatsappMessage.create.mock.calls[0][0].data as {
        profile_id: string | null;
      };
      expect(data.profile_id).toBe('profile-9');
    });

    it('matches both shapes the phone column is stored in', async () => {
      const prisma = makePrisma(null, { id: 'profile-9' });
      const service = makeService(prisma);

      await service.begin('whatsapp:+242 06 99 17 686', {
        kind: 'text',
        bodyPreview: 'bonjour',
      });

      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { phone: { in: ['+242069917686', '242069917686'] } },
        }),
      );
    });

    it('prefers an explicit profileId over the phone lookup', async () => {
      const prisma = makePrisma(null, { id: 'profile-9' });
      const service = makeService(prisma);

      await service.begin('+242069917686', {
        kind: 'text',
        bodyPreview: 'bonjour',
        profileId: 'profile-1',
      });

      const data = prisma.whatsappMessage.create.mock.calls[0][0].data as {
        profile_id: string | null;
      };
      expect(data.profile_id).toBe('profile-1');
      expect(prisma.profile.findFirst).not.toHaveBeenCalled();
    });

    it('still opens the row when the phone lookup fails', async () => {
      const prisma = makePrisma();
      prisma.profile.findFirst.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      const id = await service.begin('+242069917686', {
        kind: 'text',
        bodyPreview: 'bonjour',
      });

      expect(id).toBe('row-1');
      const data = prisma.whatsappMessage.create.mock.calls[0][0].data as {
        profile_id: string | null;
      };
      expect(data.profile_id).toBeNull();
    });

    it('resolves the template category from the registry', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.begin('+242069917686', {
        kind: 'template',
        templateKey: 'otp',
        bodyPreview: '[TPL:otp]',
      });

      const data = prisma.whatsappMessage.create.mock.calls[0][0].data as {
        template_category: string;
      };
      expect(data.template_category).toBe('AUTHENTICATION');
    });

    it('returns null instead of throwing when the insert fails', async () => {
      // This is the property that matters most in the whole file. A throw here
      // propagates out of `attempt()`, fails the BullMQ job, and the retry
      // RESENDS a message the reader already has.
      const prisma = makePrisma();
      prisma.whatsappMessage.create.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      await expect(
        service.begin('+242069917686', { kind: 'text', bodyPreview: 'hi' }),
      ).resolves.toBeNull();
    });

    it('shouts at ERROR when a row cannot be opened, naming what went unlogged', async () => {
      // The incident this file now guards: `begin()` failed on every single
      // send for two days and the only trace was a warn that read like noise.
      // A send nobody can trace is an operational hole, so it is logged at
      // error, with enough context to say WHICH send vanished.
      const prisma = makePrisma();
      prisma.whatsappMessage.create.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);
      const error = jest.spyOn(service['logger'], 'error');

      await service.begin('+242069917686', {
        kind: 'template',
        bodyPreview: '[TPL:otp]',
        templateKey: 'otp',
      });

      expect(error).toHaveBeenCalledTimes(1);
      const [message] = error.mock.calls[0];
      expect(message).toContain('UNTRACEABLE');
      expect(message).toContain('kind=template');
      expect(message).toContain('template=otp');
    });

    it('survives its own dependency being missing', async () => {
      // Exactly what `tsx` did to this service: esbuild emits no
      // `design:paramtypes`, so Nest built it with no constructor arguments
      // and `this.prisma` was undefined on every call. The send must still go
      // out — losing the log row is bad, losing the message is worse.
      const service = makeService(undefined);

      await expect(
        service.begin('+242069917686', { kind: 'text', bodyPreview: 'hi' }),
      ).resolves.toBeNull();
    });

    it('truncates an over-long body rather than rejecting the row', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.begin('+242069917686', {
        kind: 'text',
        bodyPreview: 'x'.repeat(5000),
      });

      const data = prisma.whatsappMessage.create.mock.calls[0][0].data as {
        body_preview: string;
      };
      expect(data.body_preview).toHaveLength(2000);
      expect(data.body_preview.endsWith('…')).toBe(true);
    });
  });

  describe('markSent() / markFailed()', () => {
    it('records the provider id and stamps sent_at', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.markSent('row-1', 'wamid.abc', 'cloud');

      expect(prisma.whatsappMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'row-1' },
          data: expect.objectContaining({
            provider: 'cloud',
            provider_message_id: 'wamid.abc',
            status: WhatsappDeliveryStatus.SENT,
          }),
        }),
      );
    });

    it('does nothing when there is no row — begin() having failed', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.markSent(null, 'wamid.abc', 'cloud');
      await service.markFailed(null, 'cloud', new Error('nope'));

      expect(prisma.whatsappMessage.update).not.toHaveBeenCalled();
    });

    it('keeps the normalized error code from a WhatsappError', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.markFailed(
        'row-1',
        'cloud',
        new WhatsappError({
          code: 'OUTSIDE_MESSAGING_WINDOW',
          provider: 'cloud',
          message: 'outside the window',
          providerCode: 131047,
        }),
      );

      expect(prisma.whatsappMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WhatsappDeliveryStatus.FAILED,
            error_code: 'OUTSIDE_MESSAGING_WINDOW',
            error_provider_code: 131047,
            error_message: 'outside the window',
          }),
        }),
      );
    });

    it('falls back to UNKNOWN for an error the providers did not classify', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.markFailed('row-1', 'cloud', new Error('socket hang up'));

      expect(prisma.whatsappMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            error_code: 'UNKNOWN',
            error_provider_code: null,
            error_message: 'socket hang up',
          }),
        }),
      );
    });
  });

  describe('applyStatus()', () => {
    it('advances SENT to DELIVERED and stamps delivered_at', async () => {
      const prisma = makePrisma(existingRow());
      const service = makeService(prisma);

      await service.applyStatus(status({ status: 'delivered' }));

      const data = prisma.whatsappMessage.update.mock.calls[0][0].data;
      expect(data.status).toBe(WhatsappDeliveryStatus.DELIVERED);
      expect(data.delivered_at).toEqual(new Date('2026-08-17T10:00:00Z'));
    });

    it('does NOT walk the row back when a late `sent` lands after `read`', async () => {
      // Meta batches statuses and reorders them under retry. Taking the last
      // packet to arrive as the truth makes a message that was read look like
      // it was merely sent — the exact bug ranking exists to prevent.
      const prisma = makePrisma(
        existingRow({
          status: WhatsappDeliveryStatus.READ,
          delivered_at: new Date('2026-08-17T09:59:30Z'),
          read_at: new Date('2026-08-17T09:59:45Z'),
        }),
      );
      const service = makeService(prisma);

      await service.applyStatus(status({ status: 'sent' }));

      // Nothing to advance and nothing to stamp, so the write is skipped
      // outright rather than issued with an empty payload.
      expect(prisma.whatsappMessage.update).not.toHaveBeenCalled();
    });

    it('still records the timestamp from a late callback', async () => {
      // The status must not regress, but the callback is still telling the
      // truth about WHEN the message was sent, and that column was empty.
      const prisma = makePrisma(
        existingRow({ status: WhatsappDeliveryStatus.READ, sent_at: null }),
      );
      const service = makeService(prisma);

      await service.applyStatus(
        status({ status: 'sent', timestamp: new Date('2026-08-17T09:58:00Z') }),
      );

      const data = prisma.whatsappMessage.update.mock.calls[0][0].data;
      expect(data.sent_at).toEqual(new Date('2026-08-17T09:58:00Z'));
      expect(data.status).toBeUndefined();
    });

    it('lets FAILED win over an already-read row', async () => {
      const prisma = makePrisma(
        existingRow({ status: WhatsappDeliveryStatus.READ }),
      );
      const service = makeService(prisma);

      await service.applyStatus(
        status({
          status: 'failed',
          error: {
            code: 'INVALID_RECIPIENT',
            providerCode: 131026,
            message: 'not on WhatsApp',
          },
        }),
      );

      const data = prisma.whatsappMessage.update.mock.calls[0][0].data;
      expect(data.status).toBe(WhatsappDeliveryStatus.FAILED);
      expect(data.error_code).toBe('INVALID_RECIPIENT');
    });

    it('does not overwrite a timestamp that is already set', async () => {
      const prisma = makePrisma(
        existingRow({
          status: WhatsappDeliveryStatus.DELIVERED,
          delivered_at: new Date('2026-08-17T09:00:00Z'),
        }),
      );
      const service = makeService(prisma);

      await service.applyStatus(status({ status: 'delivered' }));

      const call = prisma.whatsappMessage.update.mock.calls[0];
      expect(call?.[0]?.data?.delivered_at).toBeUndefined();
    });

    it('prefers our own id over the provider id when correlating', async () => {
      const prisma = makePrisma(existingRow());
      const service = makeService(prisma);

      await service.applyStatus(status({ internalMessageId: 'row-1' }));

      expect(prisma.whatsappMessage.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'row-1' } }),
      );
    });

    it('falls back to the provider id — the only handle the Twilio path has', async () => {
      const prisma = makePrisma();
      prisma.whatsappMessage.findUnique
        .mockResolvedValueOnce(null) // by internal id
        .mockResolvedValueOnce(existingRow()); // by provider id
      const service = makeService(prisma);

      await service.applyStatus(
        status({ internalMessageId: 'not-a-row', providerMessageId: 'SM123' }),
      );

      expect(prisma.whatsappMessage.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { provider_message_id: 'SM123' } }),
      );
      expect(prisma.whatsappMessage.update).toHaveBeenCalled();
    });

    it('backfills the provider id when the match came via our own id', async () => {
      const prisma = makePrisma(existingRow({ provider_message_id: null }));
      const service = makeService(prisma);

      await service.applyStatus(
        status({ internalMessageId: 'row-1', providerMessageId: 'wamid.late' }),
      );

      const data = prisma.whatsappMessage.update.mock.calls[0][0].data;
      expect(data.provider_message_id).toBe('wamid.late');
    });

    it('ignores a status for a message that was never logged', async () => {
      // Expected, not exceptional: rows predating this feature, and anything a
      // script sent outside the application.
      const prisma = makePrisma(null);
      const service = makeService(prisma);

      await service.applyStatus(status({ providerMessageId: 'wamid.ghost' }));

      expect(prisma.whatsappMessage.update).not.toHaveBeenCalled();
    });

    it('merges pricing in when it arrives on the delivered callback', async () => {
      const prisma = makePrisma(existingRow());
      const service = makeService(prisma);

      await service.applyStatus(
        status({
          status: 'delivered',
          pricing: { billable: true, category: 'UTILITY' },
        }),
      );

      const data = prisma.whatsappMessage.update.mock.calls[0][0].data;
      expect(data.pricing_category).toBe('UTILITY');
      expect(data.billable).toBe(true);
    });

    it('never throws when the database is unavailable', async () => {
      const prisma = makePrisma(existingRow());
      prisma.whatsappMessage.findUnique.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      await expect(service.applyStatus(status())).resolves.toBeUndefined();
    });
  });

  describe('recordInbound()', () => {
    type MessageEvent = Extract<InboundEvent, { kind: 'message' }>;
    const at = new Date('2026-09-17T09:35:00Z');
    const inbound = (over: Partial<MessageEvent> = {}): MessageEvent => ({
      kind: 'message',
      from: '+242066294896',
      providerMessageId: 'wamid.in.1',
      timestamp: at,
      provider: 'cloud',
      content: { type: 'text', text: 'Bonjour' },
      profileName: 'Jean K.',
      ...over,
    });

    it('writes a RECEIVED inbound row carrying the WhatsApp name', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.recordInbound(inbound());

      expect(prisma.whatsappMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: 'INBOUND',
            status: WhatsappDeliveryStatus.RECEIVED,
            provider: 'cloud',
            provider_message_id: 'wamid.in.1',
            to_phone: '+242066294896',
            profile_id: null,
            kind: 'text',
            body_preview: 'Bonjour',
            wa_profile_name: 'Jean K.',
            received_at: at,
          }),
        }),
      );
    });

    it('links the row and the contact to the profile owning the number', async () => {
      const prisma = makePrisma(null, { id: 'profile-9' });
      const service = makeService(prisma);

      await service.recordInbound(inbound());

      expect(
        prisma.whatsappMessage.create.mock.calls[0][0].data.profile_id,
      ).toBe('profile-9');
      expect(
        prisma.whatsappContact.upsert.mock.calls[0][0].update.profile_id,
      ).toBe('profile-9');
    });

    it('opens the contact on first sight and counts later messages', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.recordInbound(inbound());

      const args = prisma.whatsappContact.upsert.mock.calls[0][0];
      expect(args.where).toEqual({ phone: '+242066294896' });
      expect(args.create).toEqual(
        expect.objectContaining({
          wa_profile_name: 'Jean K.',
          first_seen_at: at,
          last_seen_at: at,
          inbound_count: 1,
        }),
      );
      expect(args.update).toEqual(
        expect.objectContaining({
          last_seen_at: at,
          inbound_count: { increment: 1 },
          wa_profile_name: 'Jean K.',
        }),
      );
    });

    it('never erases a known name with an event that has none', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.recordInbound(inbound({ profileName: undefined }));

      const args = prisma.whatsappContact.upsert.mock.calls[0][0];
      expect(args.update).not.toHaveProperty('wa_profile_name');
      expect(
        prisma.whatsappMessage.create.mock.calls[0][0].data.wa_profile_name,
      ).toBeNull();
    });

    it('ignores a replay: no second row, no second count', async () => {
      const prisma = makePrisma();
      prisma.whatsappMessage.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      const service = makeService(prisma);

      await expect(service.recordInbound(inbound())).resolves.toBeUndefined();
      expect(prisma.whatsappContact.upsert).not.toHaveBeenCalled();
    });

    it('still keeps the contact when the row cannot be written', async () => {
      const prisma = makePrisma();
      prisma.whatsappMessage.create.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      await expect(service.recordInbound(inbound())).resolves.toBeUndefined();
      expect(prisma.whatsappContact.upsert).toHaveBeenCalled();
    });

    it('never throws when the contact write fails too', async () => {
      const prisma = makePrisma();
      prisma.whatsappMessage.create.mockRejectedValue(new Error('db down'));
      prisma.whatsappContact.upsert.mockRejectedValue(new Error('db down'));
      const service = makeService(prisma);

      await expect(service.recordInbound(inbound())).resolves.toBeUndefined();
    });

    it('keeps the structured parts of a non-text message', async () => {
      const prisma = makePrisma();
      const service = makeService(prisma);

      await service.recordInbound(
        inbound({
          content: {
            type: 'image',
            mediaId: 'media-1',
            caption: 'Mon CV',
            mimeType: 'image/jpeg',
          },
        }),
      );

      const data = prisma.whatsappMessage.create.mock.calls[0][0].data;
      expect(data.kind).toBe('image');
      expect(data.body_preview).toBe('[Image] Mon CV');
      expect(data.variables).toEqual({
        mediaId: 'media-1',
        mimeType: 'image/jpeg',
      });
    });
  });
});

describe('describeInbound()', () => {
  it.each([
    [{ type: 'text', text: 'Salut' }, 'Salut'],
    [{ type: 'interactive_reply', replyId: 'menu_1', title: 'Menu' }, 'Menu'],
    [{ type: 'interactive_reply', replyId: 'menu_1' }, 'menu_1'],
    [{ type: 'image', mediaId: 'm' }, '[Image]'],
    [{ type: 'video', mediaId: 'm', caption: 'démo' }, '[Video] démo'],
    [{ type: 'audio', mediaId: 'm' }, '[Voice note]'],
    [
      { type: 'document', mediaId: 'm', filename: 'cv.pdf' },
      '[Document: cv.pdf]',
    ],
    [
      {
        type: 'location',
        latitude: -4.26,
        longitude: 15.28,
        name: 'Poto-Poto',
      },
      '[Location] Poto-Poto',
    ],
    [
      { type: 'location', latitude: -4.26, longitude: 15.28 },
      '[Location] -4.26, 15.28',
    ],
    [
      { type: 'reaction', emoji: '👍', targetMessageId: 'wamid.x' },
      '[Reaction 👍]',
    ],
    [
      { type: 'reaction', emoji: '', targetMessageId: 'wamid.x' },
      '[Reaction removed]',
    ],
    [{ type: 'flow_reply', answers: {} }, '[Form submitted]'],
    [{ type: 'unsupported', rawType: 'sticker' }, '[sticker]'],
  ])('%j → %s', (content, expected) => {
    expect(describeInbound(content as never)).toBe(expected);
  });
});
