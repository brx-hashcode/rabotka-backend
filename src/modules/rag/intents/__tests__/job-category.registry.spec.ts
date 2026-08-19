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
