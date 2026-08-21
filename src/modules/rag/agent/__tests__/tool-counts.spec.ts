import { ApplicationStatus, ProfileType } from '@prisma/client';
import { buildTools } from '../tools';

/**
 * Les CHIFFRES que les outils renvoient.
 *
 * Le prompt interdit au modèle d'inventer un nombre et lui demande d'être
 * concret (« *4 candidatures, 2 en attente* »). Il rapporte donc fidèlement ce
 * que l'outil lui donne — ce qui rend un outil qui compte mal pire qu'un outil
 * qui ne compte pas : le chiffre arrive avec toute l'autorité de la base, et
 * personne côté utilisateur ne peut le contredire.
 *
 * Deux outils comptaient la longueur d'une page paginée.
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

const pick = (tools: ReturnType<typeof buildTools>, name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} introuvable`);
  return t;
};

describe('candidatures_recues', () => {
  it('annonce le vrai total, pas la taille de la page', async () => {
    // 45 candidatures, dont 12 en attente, page de 10.
    const findByEmployer = jest
      .fn()
      .mockImplementation((_id: string, opts: { status?: string }) =>
        Promise.resolve(
          opts?.status === ApplicationStatus.PENDING
            ? { items: [], total: 12 }
            : { items: new Array(10).fill({ status: 'PENDING' }), total: 45 },
        ),
      );

    const payload = parse(
      await pick(
        toolsFor(ProfileType.EMPLOYER, {
          applications: { findByEmployer } as never,
        }),
        'candidatures_recues',
      ).invoke({}),
    );

    expect(payload.total).toBe(45);
    expect(payload.en_attente).toBe(12);
  });

  it('compte les en-attente sur toute la base, pas dans la page', async () => {
    // Piège : aucune PENDING dans la page ramenée, mais 7 au total. Un filtre
    // local aurait répondu « 0 en attente ».
    const findByEmployer = jest
      .fn()
      .mockImplementation((_id: string, opts: { status?: string }) =>
        Promise.resolve(
          opts?.status === ApplicationStatus.PENDING
            ? { items: [], total: 7 }
            : { items: [{ status: 'ACCEPTED' }], total: 30 },
        ),
      );

    const payload = parse(
      await pick(
        toolsFor(ProfileType.EMPLOYER, {
          applications: { findByEmployer } as never,
        }),
        'candidatures_recues',
      ).invoke({}),
    );

    expect(payload.en_attente).toBe(7);
  });
});

describe('mes_candidatures', () => {
  it('transmet le total que le service donnait déjà', async () => {
    const getApplicationsByProfileId = jest.fn().mockResolvedValue({
      data: new Array(10).fill({ status: 'PENDING' }),
      total: 30,
      page: 1,
      limit: 10,
    });

    const payload = parse(
      await pick(
        toolsFor(ProfileType.WORKER, {
          profiles: { getApplicationsByProfileId } as never,
        }),
        'mes_candidatures',
      ).invoke({}),
    );

    // Dix lignes remontées, trente candidatures réelles.
    expect(payload.nombre).toBe(30);
    expect((payload.candidatures as unknown[]).length).toBe(10);
  });

  it('retombe sur le nombre de lignes si le total manque', async () => {
    const getApplicationsByProfileId = jest
      .fn()
      .mockResolvedValue({ data: [{ status: 'PENDING' }] });

    const payload = parse(
      await pick(
        toolsFor(ProfileType.WORKER, {
          profiles: { getApplicationsByProfileId } as never,
        }),
        'mes_candidatures',
      ).invoke({}),
    );

    expect(payload.nombre).toBe(1);
  });
});
