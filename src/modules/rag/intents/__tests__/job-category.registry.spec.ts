import { Logger } from '@nestjs/common';
import { JobCategoryRegistry } from '../job-category.registry';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const ROWS = [
  {
    id: '6',
    slug: 'merchandising-commerce',
    name: 'Merchandising & Commerce',
    description: 'Mise en rayon, facing, tenue de caisse, inventaire',
  },
  { id: '1', slug: 'plomberie', name: 'Plomberie', description: null },
  {
    id: '2',
    slug: 'garde-enfants',
    name: "Garde d'enfants",
    description: null,
  },
  { id: '3', slug: 'maconnerie', name: 'Maçonnerie', description: null },
  {
    id: '4',
    slug: 'peinture-decoration',
    name: 'Peinture & Décoration',
    description: null,
  },
  { id: '5', slug: 'moto-taxi', name: 'Moto-taxi', description: null },
];

function makeService(rows = ROWS) {
  return { jobCategory: { findMany: jest.fn(() => Promise.resolve(rows)) } };
}

function build(service: ReturnType<typeof makeService>, ttlMs = 300_000) {
  const config = { get: jest.fn(() => ttlMs) };
  return new JobCategoryRegistry(service as never, config as never);
}

describe('JobCategoryRegistry', () => {
  it('reads the live list from the database, not a compiled constant', async () => {
    const service = makeService();
    expect(await build(service).slugs()).toEqual(ROWS.map((r) => r.slug));
    expect(service.jobCategory.findMany).toHaveBeenCalled();
  });

  // The reason it is not a build-time enum: an admin can add one at any moment.
  it('picks up a category an admin added after boot', async () => {
    const rows = [...ROWS];
    const service = {
      jobCategory: { findMany: jest.fn(() => Promise.resolve(rows)) },
    };
    const registry = build(service as never);

    expect(await registry.isKnown('soudure-ferronnerie')).toBe(false);

    rows.push({
      id: '7',
      slug: 'soudure-ferronnerie',
      name: 'Soudure',
      description: null,
    });
    registry.invalidate();

    expect(await registry.isKnown('soudure-ferronnerie')).toBe(true);
  });

  it('caches within the TTL', async () => {
    const service = makeService();
    const registry = build(service);
    await registry.slugs();
    await registry.slugs();
    await registry.all();
    expect(service.jobCategory.findMany).toHaveBeenCalledTimes(1);
  });

  it('collapses a cold-cache stampede into one query', async () => {
    const service = makeService();
    const registry = build(service);
    await Promise.all([registry.all(), registry.all(), registry.all()]);
    expect(service.jobCategory.findMany).toHaveBeenCalledTimes(1);
  });

  describe('resolve', () => {
    it('matches an exact slug', async () => {
      const r = await build(makeService()).resolve('garde-enfants');
      expect(r?.slug).toBe('garde-enfants');
    });

    it('matches a name, accents and all', async () => {
      const registry = build(makeService());
      expect((await registry.resolve('Maçonnerie'))?.slug).toBe('maconnerie');
      expect((await registry.resolve('maconnerie'))?.slug).toBe('maconnerie');
      expect((await registry.resolve("garde d'enfants"))?.slug).toBe(
        'garde-enfants',
      );
    });

    it('matches a slug the model wrote with spaces or the wrong separator', async () => {
      const registry = build(makeService());
      expect((await registry.resolve('garde enfants'))?.slug).toBe(
        'garde-enfants',
      );
      expect((await registry.resolve('moto taxi'))?.slug).toBe('moto-taxi');
    });

    it('matches a partial name', async () => {
      expect((await build(makeService()).resolve('peinture'))?.slug).toBe(
        'peinture-decoration',
      );
    });

    // An invented slug must be a *result*, not a silent empty search: zero
    // offers reads to a worker as "there is no work", which is a lie.
    // « Agent de caisse » matches no category name, but a description says
    // «… tenue de caisse …». Matching names alone sent that employer to the
    // catch-all domain while the right one existed.
    it('matches the words people use, which live in the description', async () => {
      const registry = build(makeService());
      expect((await registry.resolve('tenue de caisse'))?.slug).toBe(
        'merchandising-commerce',
      );
      expect((await registry.resolve('inventaire'))?.slug).toBe(
        'merchandising-commerce',
      );
    });

    it('returns null for a category that does not exist', async () => {
      const registry = build(makeService());
      expect(await registry.resolve('astrophysique nucleaire')).toBeNull();
      expect(await registry.resolve('')).toBeNull();
      expect(await registry.resolve('   ')).toBeNull();
    });
  });

  describe('when the database is unavailable', () => {
    it('serves the previous list rather than nothing', async () => {
      const service = makeService();
      const registry = build(service, 0);
      await registry.all();

      service.jobCategory.findMany.mockRejectedValueOnce(
        new Error('connection refused'),
      );
      expect(await registry.slugs()).toHaveLength(ROWS.length);
    });

    it('returns an empty list when it has never succeeded', async () => {
      const service = {
        jobCategory: {
          findMany: jest.fn(() => Promise.reject(new Error('down'))),
        },
      };
      const registry = build(service as never);
      expect(await registry.slugs()).toEqual([]);
      expect(await registry.resolve('plomberie')).toBeNull();
    });
  });
});

/**
 * The bug this exists for: « Agent de sécurité » shares no substring with
 * « Gardiennage & Surveillance », so every literal step returned null and the
 * assistant announced « Autre » for a domain Rabotka actually has.
 */
describe('JobCategoryRegistry — semantic matching', () => {
  /** Unit vectors, so cosine is exact and the expected scores are obvious. */
  const VECTORS: Record<string, number[]> = {
    'Gardiennage & Surveillance. Surveillance de site, rondes de nuit': [
      1, 0, 0,
    ],
    Plomberie: [0, 1, 0],
    Maçonnerie: [0, 0, 1],
  };

  const SEMANTIC_ROWS = [
    {
      id: 'g',
      slug: 'gardiennage-surveillance',
      name: 'Gardiennage & Surveillance',
      description: 'Surveillance de site, rondes de nuit',
    },
    { id: 'p', slug: 'plomberie', name: 'Plomberie', description: null },
    { id: 'm', slug: 'maconnerie', name: 'Maçonnerie', description: null },
  ];

  function makeEmbeddings(queryVector: number[]) {
    return {
      embedPassages: jest.fn((texts: string[]) =>
        Promise.resolve(texts.map((t) => VECTORS[t] ?? [0, 0, 0])),
      ),
      embedQuery: jest.fn(() => Promise.resolve(queryVector)),
    };
  }

  /** Every passage sent to the embedder, across all its calls. */
  function embeddedTexts(embeddings: ReturnType<typeof makeEmbeddings>) {
    return embeddings.embedPassages.mock.calls.flatMap(([texts]) => texts);
  }

  /** Just enough of ioredis: MGET and a SET pipeline. */
  function makeRedis(stored: Record<string, string> = {}) {
    const store = new Map(Object.entries(stored));
    return {
      store,
      mget: jest.fn((keys: string[]) =>
        Promise.resolve(keys.map((k) => store.get(k) ?? null)),
      ),
      pipeline: jest.fn(() => {
        const ops: [string, string][] = [];
        const pipe = {
          set: (k: string, v: string) => {
            ops.push([k, v]);
            return pipe;
          },
          exec: () => {
            ops.forEach(([k, v]) => store.set(k, v));
            return Promise.resolve([]);
          },
        };
        return pipe;
      }),
    };
  }

  function buildSemantic(
    queryVector: number[],
    minScore = 0.82,
    rows = SEMANTIC_ROWS,
    redis?: ReturnType<typeof makeRedis>,
  ) {
    const service = {
      jobCategory: { findMany: jest.fn(() => Promise.resolve(rows)) },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'VOVA_CATEGORY_MIN_SCORE' ? minScore : 300_000,
      ),
    };
    const embeddings = makeEmbeddings(queryVector);
    const registry = new JobCategoryRegistry(
      service as never,
      config as never,
      embeddings as never,
      redis as never,
    );
    return { registry, embeddings, service, redis };
  }

  it('resolves a job title that shares no word with any category', async () => {
    // Pointing at the gardiennage vector: a perfect 1.0 cosine.
    const { registry } = buildSemantic([1, 0, 0]);
    await registry.prebuild();

    const found = await registry.resolve('agent de sécurité');

    expect(found?.slug).toBe('gardiennage-surveillance');
  });

  it('leaves the literal path in front, and never embeds when it hits', async () => {
    const { registry, embeddings } = buildSemantic([1, 0, 0]);

    expect((await registry.resolve('plomberie'))?.slug).toBe('plomberie');
    // An exact slug must not cost a model call.
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });

  it('still returns null when nothing is close enough', async () => {
    // Orthogonal to every category: cosine 0 against all three.
    const { registry } = buildSemantic([0, 0, 0]);

    expect(await registry.resolve('astrophysique')).toBeNull();
  });

  it('refuses a weak match rather than dressing it up as certainty', async () => {
    // Halfway between two categories — 0.707, under the 0.82 bar.
    const { registry } = buildSemantic([1, 1, 0]);

    expect(await registry.resolve('quelque chose de vague')).toBeNull();
  });

  it('still offers the near misses that resolve() rejected', async () => {
    // The point of suggest(): the tool can say « c'est plutôt X ? » even when
    // nothing was confident enough to answer with. Leaning towards gardiennage
    // without reaching it — 0.796, just under the 0.82 bar.
    const { registry } = buildSemantic([0.8, 0.6, 0.1]);

    expect(await registry.resolve('quelque chose de vague')).toBeNull();

    const suggestions = await registry.suggest('quelque chose de vague', 2);

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].entry.slug).toBe('gardiennage-surveillance');
    expect(suggestions[0].score).toBeCloseTo(0.796, 2);
    expect(suggestions[0].score).toBeGreaterThan(suggestions[1].score);
  });

  it('embeds each category once, however many lookups follow', async () => {
    const { registry, embeddings } = buildSemantic([1, 0, 0]);
    await registry.prebuild();

    await registry.resolve('agent de sécurité');
    await registry.resolve('vigile');
    await registry.resolve('surveillant');

    // Three categories, each embedded once — in small chunks, never again.
    expect(embeddedTexts(embeddings)).toHaveLength(3);
    expect(embeddings.embedQuery).toHaveBeenCalledTimes(3);
  });

  it('re-embeds only the category an admin actually edited', async () => {
    const rows = SEMANTIC_ROWS.map((r) => ({ ...r }));
    const { registry, embeddings } = buildSemantic([1, 0, 0], 0.82, rows);
    await registry.prebuild();
    const before = embeddedTexts(embeddings).length;

    rows[1].description = 'Fuites, robinetterie, chauffe-eau';
    registry.invalidate();
    await registry.prebuild();

    // The second build carries the edited category and nothing else.
    expect(embeddedTexts(embeddings).slice(before)).toEqual([
      'Plomberie. Fuites, robinetterie, chauffe-eau',
    ]);
  });

  it('falls back to literal matching when the embedder fails', async () => {
    // A domain lookup must never be the thing that breaks a conversation.
    const { registry, embeddings } = buildSemantic([1, 0, 0]);
    embeddings.embedQuery.mockRejectedValue(new Error('model not loaded'));

    expect(await registry.resolve('agent de sécurité')).toBeNull();
    expect((await registry.resolve('plomberie'))?.slug).toBe('plomberie');
    expect(await registry.suggest('agent de sécurité')).toEqual([]);
  });

  it('works with no embedder at all', async () => {
    // The constructor argument is @Optional(): a context without retrieval must
    // degrade to the matching this class has always done.
    const service = {
      jobCategory: { findMany: jest.fn(() => Promise.resolve(SEMANTIC_ROWS)) },
    };
    const config = { get: jest.fn(() => 300_000) };
    const registry = new JobCategoryRegistry(service as never, config as never);

    expect((await registry.resolve('plomberie'))?.slug).toBe('plomberie');
    expect(await registry.suggest('agent de sécurité')).toEqual([]);
  });

  // 21 Oct: « Chauffeur personnel » made the first lookup after a deploy build
  // all 92 vectors inside the turn — 104s with the whole API frozen.
  it('never makes a lookup wait for the vectors to be built', async () => {
    const { registry, embeddings } = buildSemantic([1, 0, 0]);
    let release: () => void = () => undefined;
    embeddings.embedPassages.mockImplementation(
      (texts: string[]) =>
        new Promise((resolve) => {
          release = () => resolve(texts.map(() => [1, 0, 0]));
        }),
    );

    // Answers now, literal-only, while the build is still pending.
    expect(await registry.suggest('agent de sécurité')).toEqual([]);
    expect(await registry.resolve('agent de sécurité')).toBeNull();
    // Two lookups, one build.
    expect(embeddings.embedPassages).toHaveBeenCalledTimes(1);
    release();
  });

  it('reloads stored vectors instead of embedding them again', async () => {
    const first = buildSemantic([1, 0, 0], 0.82, SEMANTIC_ROWS, makeRedis());
    await first.registry.prebuild();
    const stored = Object.fromEntries(first.redis!.store);
    expect(Object.keys(stored)).toHaveLength(3);

    // A restart: empty memory, same Redis.
    const second = buildSemantic(
      [1, 0, 0],
      0.82,
      SEMANTIC_ROWS,
      makeRedis(stored),
    );
    await second.registry.prebuild();

    expect(second.embeddings.embedPassages).not.toHaveBeenCalled();
    expect((await second.registry.resolve('agent de sécurité'))?.slug).toBe(
      'gardiennage-surveillance',
    );
  });

  it('embeds and stores only what Redis does not have', async () => {
    const seed = buildSemantic([1, 0, 0], 0.82, SEMANTIC_ROWS, makeRedis());
    await seed.registry.prebuild();
    const all = Object.entries(Object.fromEntries(seed.redis!.store));
    const partial = makeRedis(Object.fromEntries(all.slice(0, 2)));

    const { registry, embeddings } = buildSemantic(
      [1, 0, 0],
      0.82,
      SEMANTIC_ROWS,
      partial,
    );
    await registry.prebuild();

    expect(embeddedTexts(embeddings)).toHaveLength(1);
    expect(partial.store.size).toBe(3);
  });
});
