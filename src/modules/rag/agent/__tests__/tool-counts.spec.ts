import { ApplicationStatus, ProfileType } from '@prisma/client';
import { buildTools } from '../tools';

/**
 * What the data tools hand the model: the right rows, counted over the whole
 * base, statuses in words.
 *
 * The fakes page as the real services do — `findByEmployer` from 0,
 * `getApplicationsByProfileId` from 1. The old mocks answered any page with
 * the same rows, which is how `candidatures_recues` asked for page 1, skipped
 * the ten newest applications in production, and passed here.
 */
const parse = (raw: unknown) =>
  JSON.parse(String(raw)) as Record<string, unknown>;

function toolsFor(
  profileType: ProfileType,
  deps: Partial<Record<string, unknown>>,
) {
  return buildTools(
    {
      profiles: {} as never,
      jobOffers: {} as never,
      applications: {} as never,
      wallet: {} as never,
      unlock: {} as never,
      systemConfig: {} as never,
      help: {} as never,
      categories: {} as never,
      ...deps,
    } as never,
    { profileId: 'p-1', profileType },
    [],
  );
}

const run = async (
  tools: ReturnType<typeof buildTools>,
  name: string,
): Promise<Record<string, unknown>> => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} introuvable`);
  return parse(await t.invoke({}));
};

const received = (n: number, status: ApplicationStatus, first: string) => ({
  id: `a-${n}`,
  status,
  created_at: new Date('2026-11-24T10:00:00Z'),
  job_offer: { title: 'Nettoyage des vêtements' },
  worker: { first_name: first, last_name: 'X' },
});

/** As `ApplicationService.findByEmployer`: pages from 0, filters on `statusIn`. */
function employerFake(rows: ReturnType<typeof received>[]) {
  return jest.fn(
    (
      _id: string,
      o: { statusIn?: string[]; page: number; pageSize: number },
    ) => {
      const kept = rows.filter(
        (r) => !o.statusIn || o.statusIn.includes(r.status),
      );
      return Promise.resolve({
        items: kept.slice(o.page * o.pageSize, (o.page + 1) * o.pageSize),
        total: kept.length,
      });
    },
  );
}

describe('candidatures_recues', () => {
  // The conversation of 2026-11-25: five applications, none waiting.
  const FIVE = [
    received(1, ApplicationStatus.WAITING_PAYMENT, 'Josué'),
    received(2, ApplicationStatus.REJECTED, 'Clarisse'),
    received(3, ApplicationStatus.VIEWED, 'Patrick'),
    received(4, ApplicationStatus.REJECTED, 'Ornella'),
    received(5, ApplicationStatus.END, 'Dieudonné'),
  ];

  it('lists the newest applications, not the page after them', async () => {
    const payload = await run(
      toolsFor(ProfileType.EMPLOYER, {
        applications: { findByEmployer: employerFake(FIVE) },
      }),
      'candidatures_recues',
    );
    expect(payload.total).toBe(5);
    expect(payload.candidatures).toHaveLength(5);
  });

  it('counts each status over the whole base', async () => {
    const payload = await run(
      toolsFor(ProfileType.EMPLOYER, {
        applications: { findByEmployer: employerFake(FIVE) },
      }),
      'candidatures_recues',
    );
    expect(payload).toMatchObject({
      nouvelles_non_lues: 0,
      lues_sans_reponse: 1,
      retenues: 1,
      missions_en_cours_ou_terminees: 1,
      refusees: 2,
    });
  });

  it('names the candidate and says the status in words', async () => {
    const payload = await run(
      toolsFor(ProfileType.EMPLOYER, {
        applications: { findByEmployer: employerFake(FIVE) },
      }),
      'candidatures_recues',
    );
    expect((payload.candidatures as Record<string, unknown>[])[0]).toEqual({
      candidat: 'Josué',
      mission: 'Nettoyage des vêtements',
      recue_le: expect.any(String),
      statut: 'retenue : le paiement du déblocage du contact est en attente',
    });
  });

  it('counts past the first page', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      received(i, ApplicationStatus.PENDING, `C${i}`),
    );
    const payload = await run(
      toolsFor(ProfileType.EMPLOYER, {
        applications: { findByEmployer: employerFake(many) },
      }),
      'candidatures_recues',
    );
    expect(payload.total).toBe(45);
    expect(payload.nouvelles_non_lues).toBe(45);
    expect(payload.candidatures).toHaveLength(10);
  });
});

describe('mes_candidatures', () => {
  // As `ProfileService.getApplicationsByProfileId`: camelCase, pages from 1.
  const mine = (title: string, status: ApplicationStatus) => ({
    id: title,
    status,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    contractId: null,
    jobOffer: { title, isRemote: false, city: 'Brazzaville' },
  });

  it('keeps the mission and the date, and the true total', async () => {
    const getApplicationsByProfileId = jest.fn(
      (_id: string, page: number, limit: number) =>
        Promise.resolve({
          data: [mine('Saisie de factures', ApplicationStatus.ACCEPTED)].slice(
            (page - 1) * limit,
          ),
          total: 30,
          page,
          limit,
        }),
    );
    const payload = await run(
      toolsFor(ProfileType.WORKER, {
        profiles: { getApplicationsByProfileId },
      }),
      'mes_candidatures',
    );
    expect(getApplicationsByProfileId).toHaveBeenCalledWith('p-1', 1, 10);
    expect(payload.nombre).toBe(30);
    expect(
      (payload.candidatures as Record<string, unknown>[])[0],
    ).toMatchObject({
      mission: 'Saisie de factures',
      ville: 'Brazzaville',
      statut: 'acceptée',
    });
  });
});

describe('mes_penalites', () => {
  it('tells paid from unpaid, and the amount still due', async () => {
    const getPenaltiesByProfileId = jest.fn().mockResolvedValue([
      {
        id: '1',
        amount: 2000,
        reason: 'Absence',
        appliedAt: new Date(),
        paidAt: null,
        jobOfferTitle: 'Inventaire',
      },
      {
        id: '2',
        amount: 1000,
        reason: 'Retard',
        appliedAt: new Date(),
        paidAt: new Date(),
        jobOfferTitle: null,
      },
    ]);
    const payload = await run(
      toolsFor(ProfileType.WORKER, { profiles: { getPenaltiesByProfileId } }),
      'mes_penalites',
    );
    expect(payload).toMatchObject({ impayees: 1, montant_impaye_fcfa: 2000 });
    expect((payload.penalites as Record<string, unknown>[])[0]).toMatchObject({
      payee: 'non',
      mission: 'Inventaire',
    });
  });
});
