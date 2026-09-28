import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ClientErrorsController } from '../client-errors.controller';

describe('ClientErrorsController', () => {
  let app: INestApplication;
  let warn: jest.SpyInstance;

  const report = {
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'title')",
    path: '/candidatures/:id/paiement',
    stack: 'TypeError: …\n    at ApplicationPaymentInner',
    version: '1.0.0',
  };

  beforeEach(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [ClientErrorsController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Same options as main.ts, so an unexpected field is rejected here too.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    warn.mockRestore();
    await app.close();
  });

  it('logs a valid report as one JSON line and answers 204', async () => {
    await request(app.getHttpServer())
      .post('/client-errors')
      .set('user-agent', 'WhatsApp/2.24 iPhone')
      .send(report)
      .expect(204);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      name: 'TypeError',
      path: '/candidatures/:id/paiement',
      userAgent: 'WhatsApp/2.24 iPhone',
    });
  });

  it('rejects an oversize field without logging it', async () => {
    await request(app.getHttpServer())
      .post('/client-errors')
      .send({ ...report, stack: 'x'.repeat(4001) })
      .expect(400);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects fields outside the DTO', async () => {
    await request(app.getHttpServer())
      .post('/client-errors')
      .send({ ...report, profileId: 'someone-else' })
      .expect(400);
  });

  it('throttles a burst of reports', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 10; i++) {
      await request(server).post('/client-errors').send(report).expect(204);
    }
    await request(server).post('/client-errors').send(report).expect(429);
  });
});
