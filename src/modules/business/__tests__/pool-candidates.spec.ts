import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PoolCandidatesService } from '../pool-candidates.service';

const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
const past = new Date(Date.now() - 3600 * 1000);

function make() {
  const prisma: any = {
    externalApplication: {
      findFirst: jest.fn().mockResolvedValue({ pool_expires_at: future }),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        first_name: 'Jean',
        email: 'jean@example.com',
        job_offer_id: 'o-old',
      }),
    },
    cvScreeningResume: {
      findFirst: jest.fn().mockResolvedValue({
        cv_text: 'CV',
        expires_at: future,
        screening: { expires_at: future },
      }),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        candidate: { name: 'Awa Mbemba', email: 'awa@example.com' },
      }),
    },
    businessTalent: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    jobOffer: {
      findFirst: jest.fn().mockResolvedValue({
        title: 'Caissière',
        status: 'ACTIVE',
        reference: 'RBT-1',
        employer: { business: { name: 'KAMOA', public_slug: 'kamoa' } },
      }),
    },
  };
  const mail: any = { sendMail: jest.fn().mockResolvedValue({ jobId: 'j' }) };
  const layout: any = {
    wrap: jest.fn((html: string) => Promise.resolve(html)),
  };
  return {
    service: new PoolCandidatesService(prisma, mail, layout),
    prisma,
    mail,
  };
}

describe('PoolCandidatesService', () => {
  it('keeps a careers candidate only within their consent, and only its own', async () => {
    const { service, prisma } = make();
    await expect(
      service.save('biz', 'external', 'e1', {
        note: ' Bon profil ',
        tags: ['caisse', 'Caisse'],
      }),
    ).resolves.toEqual({
      kept: true,
      note: 'Bon profil',
      tags: ['caisse'],
    });
    expect(prisma.externalApplication.findFirst.mock.calls[0][0].where).toEqual(
      {
        id: 'e1',
        job_offer: { employer_id: 'biz' },
      },
    );

    prisma.externalApplication.findFirst.mockResolvedValueOnce({
      pool_expires_at: null,
    });
    await expect(
      service.save('biz', 'external', 'e2', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.externalApplication.findFirst.mockResolvedValueOnce({
      pool_expires_at: past,
    });
    await expect(
      service.save('biz', 'external', 'e3', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.externalApplication.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.save('other', 'external', 'e1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps an analysed CV only while it is kept', async () => {
    const { service, prisma } = make();
    prisma.cvScreeningResume.findFirst.mockResolvedValueOnce({
      cv_text: null,
      expires_at: future,
      screening: { expires_at: future },
    });
    await expect(service.save('biz', 'cv', 'r1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.save('biz', 'cv', 'r1', {})).resolves.toMatchObject({
      kept: true,
    });
    expect(prisma.businessTalent.upsert.mock.calls[0][0].create).toMatchObject({
      employer_id: 'biz',
      cv_resume_id: 'r1',
    });
  });

  it('invites by e-mail to an open offer, with its careers-page link', async () => {
    const { service, mail } = make();
    await expect(service.invite('biz', 'cv', 'r1', 'o1')).resolves.toEqual({
      invited: true,
    });
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('awa@example.com');
    expect(sent.html).toContain('/carrieres/kamoa/RBT-1?source=invitation');
    expect(sent.html).toContain('Bonjour Awa');
  });

  it('refuses an offer they already applied to, a closed one, and no careers page', async () => {
    const { service, prisma } = make();
    await expect(
      service.invite('biz', 'external', 'e1', 'o-old'),
    ).rejects.toBeInstanceOf(ConflictException);
    prisma.jobOffer.findFirst.mockResolvedValueOnce({
      title: 'x',
      status: 'FILLED',
      reference: 'R',
      employer: { business: { name: 'K', public_slug: 'k' } },
    });
    await expect(
      service.invite('biz', 'cv', 'r1', 'o1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.jobOffer.findFirst.mockResolvedValueOnce({
      title: 'x',
      status: 'ACTIVE',
      reference: 'R',
      employer: { business: { name: 'K', public_slug: null } },
    });
    await expect(
      service.invite('biz', 'cv', 'r1', 'o1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
