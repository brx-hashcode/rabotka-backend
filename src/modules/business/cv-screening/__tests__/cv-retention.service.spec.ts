import { CvRetentionService } from '../cv-retention.service';
import {
  businessCvExpiringEmail,
  businessCvExpiringSubject,
} from '../../../mail/templates/business-activity';

function make(rows: unknown[][] = []) {
  const prisma: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest
      .fn()
      .mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
    $transaction: jest.fn().mockResolvedValue([]),
    externalApplication: { updateMany: jest.fn() },
    cvScreeningResume: { updateMany: jest.fn() },
    answerFile: { updateMany: jest.fn() },
    jobOffer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    cvScreening: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    business: {
      findUnique: jest.fn().mockResolvedValue({
        profile_id: 'p1',
        profile: { email: 'rh@biz.cg', first_name: 'Awa' },
      }),
    },
    businessMember: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const mail: any = { sendMail: jest.fn() };
  const events: any = { emit: jest.fn() };
  const service = new CvRetentionService(
    prisma,
    { getCvLimitMonths: jest.fn().mockResolvedValue(24) } as any,
    mail,
    { wrap: jest.fn((h: string) => Promise.resolve(h)) } as any,
    events,
  );
  return { service, prisma, mail, events };
}

const NOW = new Date('2026-11-24T10:00:00Z');

/** The SQL of each statement run, its fragments and values together. */
const ran = (prisma: any) =>
  prisma.$executeRaw.mock.calls.map(
    ([strings, ...values]: [string[], ...unknown[]]) => ({
      sql: strings
        .map((s, i) => {
          const v = values[i] as { strings?: string[] } | undefined;
          return (
            s + (v?.strings ? v.strings.join('') : v === undefined ? '' : '?')
          );
        })
        .join('')
        .replace(/\s+/g, ' '),
      values,
    }),
  );

describe('CvRetentionService', () => {
  it('moves dates on only for offers still recruiting, the limit away', async () => {
    const { service, prisma } = make();
    await service.refresh(NOW);
    const moved = ran(prisma).filter(({ values }: any) =>
      values.some(
        (v: unknown) =>
          v instanceof Date && v.toISOString() === '2028-11-24T10:00:00.000Z',
      ),
    );
    // Analysed CVs, screenings, careers originals, « Fichier » answers.
    expect(moved).toHaveLength(4);
    for (const { sql } of moved) {
      expect(sql).toContain("o.status IN ('ACTIVE', 'PARTIALLY_FILLED')");
      expect(sql).toContain('o.deleted_at IS NULL');
    }
    // Never one the business deleted.
    expect(moved[0].sql).toContain('r.removed_at IS NULL');
    expect(moved[2].sql).toContain('a.cv_removed_at IS NULL');
    expect(moved[3].sql).toContain('f.removed_at IS NULL');
  });

  it('ends a withdrawn candidate’s CV, and its « Fichier » answers, with the offer', async () => {
    const file = '11111111-1111-4111-8111-111111111111';
    const { service, prisma } = make([
      [
        {
          id: 'x1',
          cv_resume_id: 'r1',
          answers: [{ kind: 'FILE', value: `${file}:diplome.pdf` }],
        },
      ],
    ]);
    await service.refresh(NOW);
    expect(prisma.externalApplication.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['x1'] } },
      data: { cv_expires_at: NOW },
    });
    expect(prisma.cvScreeningResume.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] } },
      data: { expires_at: NOW },
    });
    expect(prisma.answerFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [file] } },
      data: { expires_at: NOW },
    });
  });

  it('lets no purge run when the dates could not be brought up to date', async () => {
    const { service, prisma } = make();
    prisma.$executeRaw.mockRejectedValue(new Error('db down'));
    await expect(service.refresh(NOW)).rejects.toThrow('db down');
  });

  const offers = [
    {
      id: 'o1',
      title: 'Caissier',
      business_id: 'b1',
      until: new Date('2026-12-20T00:00:00Z'),
    },
    {
      id: 'o2',
      title: 'Agent',
      business_id: 'b1',
      until: new Date('2026-12-10T00:00:00Z'),
    },
  ];

  it('tells a business once, in one e-mail and one notice, soonest first', async () => {
    const { service, mail, events } = make([offers, []]);
    await expect(service.announce(NOW)).resolves.toBe(1);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0]).toMatchObject({ to: 'rh@biz.cg' });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit.mock.calls[0][1]).toMatchObject({
      recipientId: 'p1',
      input: { type: 'CV_EXPIRING', jobTitle: 'Agent', others: 1 },
    });
  });

  it('says nothing that another sweep already said', async () => {
    const { service, prisma, mail } = make([offers, []]);
    prisma.jobOffer.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.announce(NOW)).resolves.toBe(0);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('writes the e-mail in both languages, titles escaped', () => {
    const items = [
      {
        title: 'Chef <b>rang</b>',
        until: new Date('2028-11-24T00:00:00Z'),
        url: 'https://x/espace/offres/o1',
      },
    ];
    const fr = businessCvExpiringEmail('Awa', items);
    expect(fr).toContain('24 novembre 2028');
    expect(fr).toContain('&lt;b&gt;');
    expect(businessCvExpiringEmail('Awa', items, 'en')).toContain(
      '24 November 2028',
    );
    expect(businessCvExpiringSubject('en')).toContain('CVs');
  });
});
