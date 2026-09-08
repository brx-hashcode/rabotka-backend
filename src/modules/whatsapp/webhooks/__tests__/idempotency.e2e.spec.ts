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
import { QueueService } from '../../../../common/services/queue/queue.service';
import { SendTimingService } from '../../telemetry/send-timing.service';
import { WhatsAppFeedbackService } from '../../feedback/whatsapp-feedback.service';
import { WhatsappMessageLogService } from '../../logging/whatsapp-message-log.service';
import {
  IdempotencyService,
  REDIS_CONNECTION_FOR_TESTS,
} from './idempotency-e2e.helpers';
import {
  WhatsAppInboundProcessor,
  type WhatsAppInboundJobData,
} from '../../whatsapp-inbound.processor';
import { ConversationService } from '../../../conversation/conversation.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
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
                id: 'wamid.dup-1',
                timestamp: '1754870400',
                type: 'text',
                text: { body: '/start' },
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
 * A real CloudProvider — signature verification has to be the genuine article,
 * since "the guard did not loosen it" is one of the things being asserted — but
 * with the two acknowledgement calls stubbed.
 *
 * Without the stubs this suite makes live HTTPS calls to graph.facebook.com
 * with a fake token on every delivery: slow, dependent on the network, and it
 * leaves the fetches pending after the run.
 */
function makeProvider(): CloudProvider {
  const provider = new CloudProvider(CONFIG);
  jest.spyOn(provider, 'markAsRead').mockResolvedValue(undefined);
  jest.spyOn(provider, 'sendTypingIndicator').mockResolvedValue(undefined);
  return provider;
}

/**
 * The acceptance criterion, end to end: the same signed webhook delivered twice
 * produces exactly ONE outbound message.
 *
 * Everything between the HTTP boundary and the outbound queue is real — the
 * CSRF middleware, the throttler, `rawBody: true`, signature verification, the
 * ingest service, the idempotency claim, and the inbound processor. Only the
 * edges are faked: Redis is an in-memory map that implements SET NX honestly,
 * the queue collects jobs, and the bot returns a fixed reply.
 *
 * This is the shape of the reported bug — one /start, two welcomes — so it is
 * the test that would have caught it.
 */
describe('duplicate webhook delivery', () => {
  let app: INestApplication;
  let processor: WhatsAppInboundProcessor;
  const inboundJobs: WhatsAppInboundJobData[] = [];
  const outboundJobs: unknown[] = [];
  const seenJobIds = new Set<string>();

  const queueService = {
    addJob: jest.fn(
      (queue: string, data: unknown, options?: { jobId?: string }) => {
        if (queue.includes('inbound')) {
          // BullMQ refuses a second add under an id it already holds. Modelled
          // here because it is the first of the three layers.
          if (options?.jobId) {
            if (seenJobIds.has(options.jobId))
              return Promise.resolve(undefined);
            seenJobIds.add(options.jobId);
          }
          inboundJobs.push(data as WhatsAppInboundJobData);
        } else {
          outboundJobs.push(data);
        }
        return Promise.resolve(undefined);
      },
    ),
    createWorker: jest.fn().mockReturnValue({}),
  };

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
        InboundIngestService,
        WhatsAppInboundProcessor,
        IdempotencyService,
        REDIS_CONNECTION_FOR_TESTS,
        { provide: QueueService, useValue: queueService },
        { provide: WHATSAPP_PROVIDER, useValue: makeProvider() },
        {
          provide: SendTimingService,
          useValue: {
            time: (
              _s: string,
              _d: string,
              _m: unknown,
              fn: () => Promise<unknown>,
            ) => fn(),
            recordDelivered: jest.fn(),
          },
        },
        {
          provide: WhatsAppFeedbackService,
          useValue: { handleSubmission: jest.fn() },
        },
        {
          // Faked like the other edges: this test is about de-duplication, and
          // the delivery log is a write it makes on the way through.
          provide: WhatsappMessageLogService,
          useValue: { applyStatus: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConversationService,
          useValue: {
            handleIncomingMessage: jest.fn().mockResolvedValue({
              replies: ['Bienvenue !'],
              profileId: 'p-1',
            }),
          },
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
    processor = moduleRef.get(WhatsAppInboundProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  const url = '/api/v1/webhooks/whatsapp/cloud';

  /**
   * Each test uses its own wamid. The claim is meant to outlive a test run —
   * that is the entire point of a 7-day TTL — so sharing one id would leak
   * state between cases and the later ones would pass for the wrong reason.
   */
  const payloadFor = (wamid: string) =>
    JSON.stringify({
      ...PAYLOAD,
      entry: [
        {
          ...PAYLOAD.entry[0],
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    ...PAYLOAD.entry[0].changes[0].value.messages[0],
                    id: wamid,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

  const post = (wamid: string) => {
    const raw = payloadFor(wamid);
    const signature = `sha256=${createHmac('sha256', 'app-secret')
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;
    return request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(raw);
  };

  /** Drain whatever the webhook enqueued, as BullMQ would. */
  const drain = async (attemptsMade = 0) => {
    while (inboundJobs.length) {
      const data = inboundJobs.shift()!;
      await processor.process({ data, attemptsMade });
    }
  };

  beforeEach(() => {
    outboundJobs.length = 0;
    inboundJobs.length = 0;
  });

  it('sends exactly one outbound message for two identical deliveries', async () => {
    // The acceptance criterion. Note it passes on EITHER layer alone — that is
    // defence in depth working, not a redundant test, but it means this case
    // does not isolate a single mechanism. The two below do: they each fail if
    // the worker's claim is removed, and the jobId layer is pinned by an exact
    // assertion in inbound-ingest.service.spec.ts.
    await post('wamid.a').expect(200);
    await post('wamid.a').expect(200);

    await drain();

    expect(outboundJobs).toHaveLength(1);
  });

  it('still sends exactly one when the replay arrives after the job record is gone', async () => {
    // The 38-minute case. removeOnComplete drops the BullMQ record after an
    // hour, so jobId cannot help — the worker's claim is the only thing left.
    seenJobIds.clear(); // the record has aged out

    await post('wamid.b').expect(200);
    await drain();
    expect(outboundJobs).toHaveLength(1);

    seenJobIds.clear();
    await post('wamid.b').expect(200);
    await drain();

    expect(outboundJobs).toHaveLength(1);
  });

  it('does not re-send when BullMQ retries a job that already handled it', async () => {
    seenJobIds.clear();

    await post('wamid.c').expect(200);
    const [job] = inboundJobs;
    await drain();
    expect(outboundJobs).toHaveLength(1);

    // Same job, second attempt — what a mid-handling throw produces.
    await processor.process({ data: job, attemptsMade: 1 });

    expect(outboundJobs).toHaveLength(1);
  });

  it('still rejects an unsigned replay with 403', async () => {
    // The guard must not have loosened signature verification.
    await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .send(payloadFor('wamid.d'))
      .expect(403);
    expect(inboundJobs).toHaveLength(0);
  });

  it('delivers on retry when handling threw the first time', async () => {
    // The acceptance criterion the original work never actually tested. A
    // failure after the claim used to be indistinguishable from a duplicate,
    // so BullMQ's retry dropped the message and the reader got nothing.
    seenJobIds.clear();

    // The cast is load-bearing: the container is typed with the real service
    // but holds the mock registered above. (An eslint --fix once removed this
    // as an "unnecessary assertion" and broke this test.)
    const bot = app.get(ConversationService) as unknown as {
      handleIncomingMessage: jest.Mock;
    };
    bot.handleIncomingMessage
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ replies: ['Bienvenue !'], profileId: 'p-1' });

    await post('wamid.retry').expect(200);
    const [job] = inboundJobs;

    // Attempt 1 throws, so BullMQ would retry.
    await expect(
      processor.process({ data: job, attemptsMade: 0 }),
    ).rejects.toThrow('db down');
    expect(outboundJobs).toHaveLength(0);

    // Attempt 2 must deliver, not treat the failure as a duplicate.
    await processor.process({ data: job, attemptsMade: 1 });

    expect(outboundJobs).toHaveLength(1);
  });
});
