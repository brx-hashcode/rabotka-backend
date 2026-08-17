import { WhatsappDeliveryStatus } from '@prisma/client';
import { WhatsappMessageLogService } from '../whatsapp-message-log.service';
import { WhatsappError, type InboundEvent } from '../../contracts';

/**
 * The delivery log's two jobs: never break a send, and never walk a row
 * backwards. Both are easy to regress and neither shows up in manual testing —
 * a lost bookkeeping write is silent, and out-of-order webhooks only arrive
 * under the load you cannot reproduce locally.
 */

type StatusEvent = Extract<InboundEvent, { kind: 'status' }>;

function makePrisma(row: Record<string, unknown> | null = null) {
  return {
    whatsappMessage: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(row),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const service = new WhatsappMessageLogService(prisma as never);
  // The service logs its own swallowed failures; the assertions below are
  // about behaviour, and a screenful of expected warnings hides real ones.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
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
});
