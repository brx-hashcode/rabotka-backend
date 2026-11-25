import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BusinessProfileGuard } from '../../../auth/guards/business-profile.guard';
import { KycVerifiedGuard } from '../../../auth/guards/kyc-verified.guard';
import { ProfileAuthGuard } from '../../../auth/guards/profile-auth.guard';
import { MailboxService } from '../../mailbox/mailbox.service';
import { CvChatService } from '../cv-chat.service';
import { CvCompareService } from '../cv-compare.service';
import { CvRemovalController } from '../cv-removal.controller';
import { CvRemovalService } from '../cv-removal.service';
import { CvScreeningController } from '../cv-screening.controller';
import { CvScreeningService } from '../cv-screening.service';

const ID = '11111111-1111-4111-8111-111111111111';
const RESUME = '22222222-2222-4222-8222-222222222222';

/**
 * The business app's client reads every success as JSON: an empty answer throws
 * there, and a deletion that worked shows as failed.
 */
describe('CV deletions over HTTP', () => {
  let app: INestApplication;
  const removal = {
    application: jest.fn().mockResolvedValue(undefined),
    external: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
  };
  const screenings = { remove: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    const signedIn = {
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => { user?: unknown } };
      }) => {
        ctx.switchToHttp().getRequest().user = { profileId: 'p1' };
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CvRemovalController, CvScreeningController],
      providers: [
        { provide: CvRemovalService, useValue: removal },
        { provide: CvScreeningService, useValue: screenings },
        { provide: CvChatService, useValue: {} },
        { provide: CvCompareService, useValue: {} },
        { provide: MailboxService, useValue: {} },
      ],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue(signedIn)
      .overrideGuard(BusinessProfileGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(KycVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it.each([
    [`applications/${ID}/cv`, removal.application, ['p1', ID]],
    [`external-applications/${ID}/cv`, removal.external, ['p1', ID]],
    [
      `cv-screenings/${ID}/resumes/${RESUME}/file`,
      removal.resume,
      ['p1', ID, RESUME],
    ],
    [`cv-screenings/${ID}`, screenings.remove, ['p1', ID]],
  ])('DELETE business/me/%s says it is done', async (path, called, args) => {
    const res = await request(app.getHttpServer())
      .delete(`/business/me/${path}`)
      .expect(200);
    expect(res.body).toEqual({ deleted: true });
    expect(called).toHaveBeenCalledWith(...args);
  });
});
