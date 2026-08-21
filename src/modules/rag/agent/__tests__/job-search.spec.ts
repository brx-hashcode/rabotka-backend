import { ProfileType, VerificationStatus } from '@prisma/client';
import { buildTools } from '../tools';
import { buildSystemPrompt } from '../prompts';

/**
 * « Y a-t-il des missions en plomberie ? »
 *
 * Le parcours : une question sur le domaine, un COMPTE en base, puis la
 * proposition d'ouvrir la liste. Ce qui est testé ici, c'est surtout ce que
 * l'outil NE renvoie PAS — il ne peut pas divulguer un titre ou un montant s'il
 * ne les reçoit jamais, et c'est cette forme-là qui tient la promesse « sans
 * informations additionnelles », pas une consigne de prompt.
 */

const CATEGORY = { id: 'cat-uuid-1', slug: 'plomberie', name: 'Plomberie' };

function makeDeps(overrides: {
  count?: jest.Mock;
  findActive?: jest.Mock;
  resolve?: jest.Mock;
}) {
  return {
    profiles: {} as never,
    jobOffers: {
      countOpenOffers: overrides.count ?? jest.fn().mockResolvedValue(0),
      findActive:
        overrides.findActive ??
        jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
    } as never,
    applications: {} as never,
    wallet: {} as never,
    unlock: {} as never,
    systemConfig: {} as never,
    help: {} as never,
    categories: {
      resolve: overrides.resolve ?? jest.fn().mockResolvedValue(CATEGORY),
    } as never,
  };
}

const ctx = { profileId: 'worker-1', profileType: ProfileType.WORKER };

function searchTool(deps: ReturnType<typeof makeDeps>) {
  const tool = buildTools(deps, ctx, ['plomberie']).find(
    (t) => t.name === 'rechercher_offres',
  );
  if (!tool) throw new Error('rechercher_offres missing from the worker tools');
  return tool;
}

/** The tools return a JSON string; these assertions are about its contents. */
const parse = (raw: unknown) =>
  JSON.parse(String(raw)) as Record<string, unknown>;

describe('rechercher_offres with a domain', () => {
  it('counts in the database instead of filtering a page', async () => {
    const count = jest.fn().mockResolvedValue(4);
    const findActive = jest.fn();
    const deps = makeDeps({ count, findActive });

    const raw = await searchTool(deps).invoke({ categorie_slug: 'plomberie' });

    expect(parse(raw)).toMatchObject({ domaine: 'plomberie', nombre: 4 });
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: CATEGORY.id,
        excludeWorkerId: 'worker-1',
      }),
    );
    // The page-of-ten path must not run: filtering it locally is what produced
    // « aucune mission » for a domain whose offers sat further down the list.
    expect(findActive).not.toHaveBeenCalled();
  });

  it('returns the count and nothing that could identify an offer', async () => {
    const deps = makeDeps({ count: jest.fn().mockResolvedValue(7) });

    const payload = parse(
      await searchTool(deps).invoke({ categorie_slug: 'plomberie' }),
    );

    // The whole point: no titles, no amounts, no addresses reach the model.
    const serialised = JSON.stringify(payload);
    for (const leak of [
      'titre',
      'title',
      'montant',
      'amount',
      'adresse',
      'missions',
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('reports zero as zero rather than as an error', async () => {
    // « Il n'y en a aucune pour l'instant » is a real answer, and the model has
    // to be able to tell it apart from a lookup that failed.
    const deps = makeDeps({ count: jest.fn().mockResolvedValue(0) });

    const payload = parse(
      await searchTool(deps).invoke({ categorie_slug: 'plomberie' }),
    );

    expect(payload).toMatchObject({ nombre: 0 });
    expect(payload).not.toHaveProperty('erreur');
  });

  it('asks for a known domain back when the word resolves to nothing', async () => {
    const deps = makeDeps({ resolve: jest.fn().mockResolvedValue(null) });

    const payload = parse(
      await searchTool(deps).invoke({ categorie_slug: 'astrophysique' }),
    );

    expect(payload).toMatchObject({ erreur: 'domaine_inconnu' });
  });

  it('still browses a sample when no criterion was given at all', async () => {
    const findActive = jest
      .fn()
      .mockResolvedValue({ data: [], nextCursor: null });
    const count = jest.fn();
    const deps = makeDeps({ findActive, count });

    await searchTool(deps).invoke({});

    expect(findActive).toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});

describe('the prompt that drives it', () => {
  const prompt = buildSystemPrompt({
    firstName: 'Marie',
    profileType: ProfileType.WORKER,
    verificationStatus: VerificationStatus.VERIFIED,
    categorySlugs: [],
    knownCategorySlugs: [],
    grounding: [],
    requiredTools: [],
    language: 'fr',
  });

  it('tells the worker path to ask for the domain', () => {
    expect(prompt).toContain('DANS QUEL DOMAINE');
    expect(prompt).toContain('rechercher_offres');
  });

  it('keeps the exact phrasing that opens the app on « oui »', () => {
    // Load-bearing string: the bot matches on it to attach the card.
    expect(prompt).toContain('Je vous ouvre *Missions disponibles* ?');
  });

  it('no longer forbids asking what the person is looking for', () => {
    expect(prompt).not.toContain("N'enquête pas sur ce qu'elle cherche");
  });

  it('still forbids collecting the details of a mission to publish', () => {
    // The rule was scoped, not dropped — an employer must still not be
    // interrogated about budget and dates.
    expect(prompt).toContain('Ne collecte JAMAIS');
    expect(prompt).toContain('budget');
  });
});

describe('rechercher_offres par ville', () => {
  it('compte en base même sans domaine', async () => {
    // Le trou que le filtrage local laissait : aucune des dix missions les plus
    // imminentes à Pointe-Noire, et VoVa concluait « aucune mission là-bas ».
    const count = jest.fn().mockResolvedValue(2);
    const findActive = jest.fn();
    const deps = makeDeps({ count, findActive });

    const payload = parse(
      await searchTool(deps).invoke({ ville: 'Pointe-Noire' }),
    );

    expect(payload).toMatchObject({ ville: 'Pointe-Noire', nombre: 2 });
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'Pointe-Noire', categoryId: null }),
    );
    expect(findActive).not.toHaveBeenCalled();
  });

  it('combine domaine et ville dans un seul compte', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const deps = makeDeps({ count });

    await searchTool(deps).invoke({
      categorie_slug: 'plomberie',
      ville: 'Brazzaville',
    });

    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: CATEGORY.id,
        city: 'Brazzaville',
      }),
    );
  });

  it('ne divulgue aucune offre sur le chemin ville non plus', async () => {
    // Même garantie que pour le domaine : la discrétion vient de la forme du
    // retour, pas d'une consigne.
    const deps = makeDeps({ count: jest.fn().mockResolvedValue(3) });

    const serialised = JSON.stringify(
      parse(await searchTool(deps).invoke({ ville: 'Pointe-Noire' })),
    );

    for (const leak of [
      'titre',
      'title',
      'montant',
      'amount',
      'adresse',
      'missions',
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });
});
