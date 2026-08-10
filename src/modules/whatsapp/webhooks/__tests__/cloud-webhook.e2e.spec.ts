import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Logger, type INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { CloudWebhookController } from '../cloud-webhook.controller';
import { InboundIngestService } from '../inbound-ingest.service';
import { CsrfModule } from '../../../csrf/csrf.module';
import { CSRF_UTILITIES } from '../../../csrf/csrf.constants';
import { csrfVisitorMiddleware } from '../../../csrf/csrf-visitor.middleware';
import { CloudProvider } from '../../providers/cloud/cloud.provider';
import { WHATSAPP_PROVIDER } from '../../contracts';
import type { CloudProviderConfig } from '../../whatsapp.config';

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

interface CsrfUtilities {
  doubleCsrfProtection: (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void;
}

/**
 * The Cloud webhook behind the middleware this app actually runs.
 *
 * Testing the controller in isolation would pass while production returned 403:
 * `doubleCsrfProtection` is mounted on every request in main.ts, and until this
 * change `skipCsrfProtection` exempted only `/whatsapp/incoming`. Meta would
 * have retried against that 403 for days without the signature check ever
 * running. The same goes for the global ThrottlerGuard, which shares a 100/min
 * per-IP budget with real traffic.
 *
 * So this boots a real Nest app with the real CSRF middleware, the real
 * throttler, the real global prefix and `rawBody: true`, and drives it over
 * HTTP.
 */
describe('Cloud webhook through the middleware chain', () => {
  let app: INestApplication;
  const ingest = { ingest: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              CSRF_SECRET: 'x'.repeat(32),
              NODE_ENV: 'test',
              THROTTLE_TTL: 60000,
              THROTTLE_LIMIT: 100,
            }),
          ],
        }),
        ThrottlerModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            throttlers: [
              {
                ttl: config.get<number>('THROTTLE_TTL', 60000),
                limit: config.get<number>('THROTTLE_LIMIT', 100),
              },
            ],
          }),
        }),
        CsrfModule,
      ],
      controllers: [CloudWebhookController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: InboundIngestService, useValue: ingest },
        {
          provide: WHATSAPP_PROVIDER,
          useValue: new CloudProvider(CONFIG),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
    app.use(cookieParser());
    app.use(csrfVisitorMiddleware);

    const csrf = app.get<CsrfUtilities>(CSRF_UTILITIES);
    app.use((req: Request, res: Response, next: NextFunction) => {
      csrf.doubleCsrfProtection(req, res, (err?: unknown) => {
        if (err) {
          res
            .status(403)
            .json({ statusCode: 403, message: 'Invalid CSRF token' });
          return;
        }
        next();
      });
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => ingest.ingest.mockClear());

  const url = '/api/v1/webhooks/whatsapp/cloud';
  const raw = JSON.stringify(PAYLOAD);
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(Buffer.from(raw, 'utf8')).digest('hex')}`;

  it('survives CSRF and the throttler with a valid signature', async () => {
    await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(raw)
      .expect(200);

    expect(ingest.ingest).toHaveBeenCalledTimes(1);
  });

  it('is NOT answered with the CSRF middleware 403', async () => {
    // The specific regression: a 403 whose body is the CSRF error rather than
    // the controller's signature rejection.
    const res = await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.body).not.toMatchObject({ message: 'Invalid CSRF token' });
  });

  it('rejects an unsigned payload with 403 from the controller', async () => {
    await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(403);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('rejects a body re-serialized after signing', async () => {
    // What `rawBody: true` exists to prevent. Same JSON value, different bytes.
    await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(JSON.stringify(PAYLOAD, null, 2))
      .expect(403);
  });

  it('answers the GET handshake as text/plain', async () => {
    const res = await request(app.getHttpServer())
      .get(url)
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': '31415926',
      })
      .expect(200);

    // A JSON body ("31415926" with quotes) fails Meta's handshake.
    expect(res.text).toBe('31415926');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('rejects the handshake with a wrong verify token', async () => {
    await request(app.getHttpServer())
      .get(url)
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': '1',
      })
      .expect(403);
  });

  it('is not rate limited across a burst, unlike a throttled route', async () => {
    // Meta batches statuses and retries hard; sharing the 100/min per-IP budget
    // with real traffic would turn a bulk send into a retry storm.
    for (let i = 0; i < 20; i++) {
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(raw)
        .expect(200);
    }
  });
});
