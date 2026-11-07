import { ForbiddenException } from '@nestjs/common';
import {
  acpeTable,
  candidatesTable,
  pay,
  staffTable,
} from '../hr-export-tables';
import { HrExportsService } from '../hr-exports.service';

const d = (iso: string) => new Date(iso);

describe('HR export tables', () => {
  it('writes pay as people read it', () => {
    expect(pay(2500, 'HOURLY')).toBe('2 500 FCFA / heure');
    expect(pay(150000, 'MONTHLY')).toBe('150 000 FCFA / mois');
    expect(pay(null, 'DAILY')).toBeNull();
    expect(pay(0, null)).toBeNull();
  });

  it('lists candidates with their status in words and the date as a date', () => {
    const t = candidatesTable([
      {
        lastName: 'Mbemba',
        firstName: 'Awa',
        origin: 'Rabotka',
        status: { rabotka: 'ACCEPTED' },
        score: 82,
        appliedAt: d('2026-11-02T10:00:00Z'),
        phone: null,
        email: null,
        knockedOut: false,
      },
      {
        lastName: 'Okemba',
        firstName: 'Jean',
        origin: 'Page carrières · LinkedIn',
        status: { careers: 'REFUSED' },
        score: null,
        appliedAt: d('2026-11-03T10:00:00Z'),
        phone: '+242061234567',
        email: 'jean@example.com',
        knockedOut: true,
      },
    ]);
    expect(t.header[0]).toBe('Nom');
    expect(t.rows[0]).toEqual([
      'Mbemba',
      'Awa',
      'Rabotka',
      'Retenue',
      82,
      '2026-11-02',
      null,
      null,
      'Non',
    ]);
    expect(t.rows[1][3]).toBe('Refusée');
    expect(t.rows[1][8]).toBe('Oui');
  });

  it('dates a mission in the register, not an open-ended contract', () => {
    const base = {
      lastName: 'A',
      firstName: 'B',
      post: 'Agent',
      reference: 'RBT-1',
      hiredAt: d('2026-11-01T00:00:00Z'),
      missionAt: d('2026-11-14T08:00:00Z'),
      amount: 1000,
      paymentFlow: 'HOURLY' as const,
      city: 'Brazzaville',
      origin: 'Rabotka',
      phone: null,
      email: null,
    };
    const t = staffTable([
      { ...base, contract: 'MISSION' },
      { ...base, contract: 'CDI' },
    ]);
    expect(t.rows[0].slice(4, 8)).toEqual([
      'Mission',
      '2026-11-01',
      '2026-11-14',
      '1 000 FCFA / heure',
    ]);
    expect(t.rows[1][6]).toBeNull();
  });

  it('leaves a column for the ACPE receipt number', () => {
    const t = acpeTable([
      {
        reference: 'RBT-1',
        title: 'Comptable',
        category: 'Comptabilité',
        contract: 'CDD',
        quantity: 2,
        city: 'Pointe-Noire',
        countryName: 'Congo',
        address: null,
        publishedAt: d('2026-11-01T00:00:00Z'),
        scheduledAt: null,
        amount: null,
        paymentFlow: null,
        description: 'Tenue\n\nde la   comptabilité',
        status: 'ACTIVE',
      },
    ]);
    expect(t.header.at(-1)).toBe('N° de récépissé ACPE');
    expect(t.rows[0]).toEqual([
      'RBT-1',
      'Comptable',
      'Comptabilité',
      'CDD',
      2,
      'Pointe-Noire',
      'Congo',
      null,
      '2026-11-01',
      null,
      null,
      'Tenue de la comptabilité',
      'En ligne',
      null,
    ]);
  });
});

describe('HrExportsService', () => {
  function make(hrExports = true) {
    const prisma: any = {
      business: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ profile_id: 'p-1', name: 'ZuaFood' }),
      },
      jobOffer: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'o-1', title: 'Agent', reference: 'RBT-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      application: { findMany: jest.fn().mockResolvedValue([]) },
      externalApplication: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const subscriptions: any = {
      businessOf: jest.fn().mockResolvedValue('biz-1'),
      entitlements: jest.fn().mockResolvedValue({ hrExports }),
    };
    return { service: new HrExportsService(prisma, subscriptions), prisma };
  }

  it('is refused when the plan leaves « Exports RH » out', async () => {
    await expect(
      make(false).service.staffRegister('p-1', 'xlsx'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gives a Rabotka candidate’s contact only once obtained', async () => {
    const { service, prisma } = make();
    const worker = {
      first_name: 'Awa',
      last_name: 'Mbemba',
      phone: '+242060000000',
      email: 'a@x.cg',
    };
    const app = (status: string | null) => ({
      status: 'ACCEPTED',
      created_at: d('2026-11-02T10:00:00Z'),
      knocked_out: false,
      agent_id: null,
      worker,
      cv_resume: null,
      assessment: { score: 70 },
      contact_unlock_attempt: status ? { status } : null,
    });
    prisma.application.findMany.mockResolvedValue([
      app('UNLOCKED'),
      app('PENDING_EMPLOYER'),
    ]);

    const file = await service.candidates('p-1', 'o-1', 'csv');

    expect(file.format).toBe('csv');
    const text = file.format === 'csv' ? file.text : '';
    const lines = text.split('\r\n').filter((l) => l.startsWith('Mbemba'));
    expect(lines[0]).toContain('+242060000000');
    expect(lines[1]).not.toContain('+242060000000');
    expect(file.filename).toBe('candidats-RBT-1.csv');
  });

  it('writes an Excel workbook by default', async () => {
    const file = await make().service.acpe('p-1', 30, 'xlsx');
    expect(file.format).toBe('xlsx');
    expect(
      file.format === 'xlsx' && file.buffer.subarray(0, 2).toString(),
    ).toBe('PK');
  });
});
