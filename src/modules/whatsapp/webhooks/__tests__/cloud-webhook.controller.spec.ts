import { ForbiddenException, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { CloudWebhookController } from '../cloud-webhook.controller';
import { CloudProvider } from '../../providers/cloud/cloud.provider';
import { TwilioProvider } from '../../providers/twilio/twilio.provider';
import type { CloudProviderConfig } from '../../whatsapp.config';
import type { TwilioService } from '../../../../common/services/twilio/twilio.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const CONFIG: CloudProviderConfig = {
  provider: 'cloud',
  apiVersion: 'v25.0',
  phoneNumberId: '111',
  accessToken: 'token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
  wabaId: '999',
};

const PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              {
                from: '242069917686',
                id: 'wamid.1',
                timestamp: '1754870400',
                type: 'text',
                text: { body: 'Bonjour' },
              },
            ],
          },
        },
      ],
    },
  ],
};

function sign(raw: Buffer, secret = 'app-secret'): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function makeReq(
  raw: Buffer,
  headers: Record<string, string>,
): RawBodyRequest<Request> {
  return {
    rawBody: raw,
    body: JSON.parse(raw.toString('utf8')) as unknown,
    headers,
  } as unknown as RawBodyRequest<Request>;
}

describe('CloudWebhookController', () => {
  const raw = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
  let ingest: { ingest: jest.Mock };

  function makeController(provider: CloudProvider | TwilioProvider) {
    ingest = { ingest: jest.fn().mockResolvedValue(undefined) };
    return new CloudWebhookController(provider, ingest as never);
  }

  const cloud = () => makeController(new CloudProvider(CONFIG));
  const twilio = () =>
    makeController(
      new TwilioProvider({
        isConfigured: () => true,
      } as unknown as TwilioService),
    );

  describe('GET handshake', () => {
    it('echoes the challenge for a correct verify token', () => {
      expect(cloud().verify('subscribe', 'verify-token', '12345')).toBe(
        '12345',
      );
    });

    it('rejects a wrong verify token', () => {
      expect(() => cloud().verify('subscribe', 'nope', '12345')).toThrow(
        ForbiddenException,
      );
    });

    it('rejects a missing verify token', () => {
      expect(() => cloud().verify('subscribe', undefined, '12345')).toThrow(
        ForbiddenException,
      );
    });

    it('rejects a mode other than subscribe', () => {
      expect(() => cloud().verify('unsubscribe', 'verify-token', 'x')).toThrow(
        ForbiddenException,
      );
    });

    it('refuses the handshake when Cloud is not the active provider', () => {
      expect(() => twilio().verify('subscribe', 'verify-token', 'x')).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('POST', () => {
    it('ingests a signed payload', async () => {
      const controller = cloud();
      await controller.receive(
        makeReq(raw, { 'x-hub-signature-256': sign(raw) }),
      );
      expect(ingest.ingest).toHaveBeenCalledTimes(1);
      const events = ingest.ingest.mock.calls[0][0] as unknown[];
      expect(events).toHaveLength(1);
    });

    it('rejects a tampered body with 403', async () => {
      const controller = cloud();
      const tampered = Buffer.from(
        JSON.stringify({ ...PAYLOAD, object: 'evil' }),
        'utf8',
      );
      await expect(
        controller.receive(
          makeReq(tampered, { 'x-hub-signature-256': sign(raw) }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('rejects a missing signature header', async () => {
      const controller = cloud();
      await expect(controller.receive(makeReq(raw, {}))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a signature made with the wrong secret', async () => {
      const controller = cloud();
      await expect(
        controller.receive(
          makeReq(raw, { 'x-hub-signature-256': sign(raw, 'wrong') }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('fails loudly when the raw body is absent', async () => {
      // Only reachable if `rawBody: true` is removed from the bootstrap, which
      // would silently 403 every webhook from then on.
      const controller = cloud();
      const req = {
        rawBody: undefined,
        body: PAYLOAD,
        headers: { 'x-hub-signature-256': sign(raw) },
      } as unknown as RawBodyRequest<Request>;
      await expect(controller.receive(req)).rejects.toThrow(ForbiddenException);
    });

    it('drops the payload with a 200 when Cloud is not active', async () => {
      // Meta retries on any non-2xx and disables a subscription that keeps
      // failing, so a stale registration must not be answered with an error.
      const controller = twilio();
      await expect(
        controller.receive(makeReq(raw, { 'x-hub-signature-256': sign(raw) })),
      ).resolves.toBeUndefined();
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('accepts an unfamiliar but signed envelope without ingesting', async () => {
      const controller = cloud();
      const other = Buffer.from(JSON.stringify({ object: 'other' }), 'utf8');
      await expect(
        controller.receive(
          makeReq(other, { 'x-hub-signature-256': sign(other) }),
        ),
      ).resolves.toBeUndefined();
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('ingests every message in a batched payload', async () => {
      const controller = cloud();
      const batched = {
        entry: [
          {
            id: 'e1',
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      from: '242001',
                      id: 'm1',
                      timestamp: '1',
                      type: 'text',
                      text: { body: 'a' },
                    },
                    {
                      from: '242002',
                      id: 'm2',
                      timestamp: '1',
                      type: 'text',
                      text: { body: 'b' },
                    },
                  ],
                  statuses: [
                    {
                      id: 'm0',
                      status: 'delivered',
                      timestamp: '1',
                      recipient_id: '242003',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const body = Buffer.from(JSON.stringify(batched), 'utf8');
      await controller.receive(
        makeReq(body, { 'x-hub-signature-256': sign(body) }),
      );
      expect((ingest.ingest.mock.calls[0][0] as unknown[]).length).toBe(3);
    });
  });
});
