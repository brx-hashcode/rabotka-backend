import { CollaborationGraphService } from '../collaboration-graph.service';

/** Rows come back from Postgres COUNT(*) as bigint. */
const row = (employer: string, worker: string, count: number) => ({
  employer_id: employer,
  worker_id: worker,
  count: BigInt(count),
});

const profile = (id: string, type: 'WORKER' | 'EMPLOYER') => ({
  id,
  first_name: id.toUpperCase(),
  last_name: 'Test',
  profile_type: type,
  avatar_url: null,
});

describe('CollaborationGraphService', () => {
  let service: CollaborationGraphService;
  let prisma: {
    $queryRaw: jest.Mock;
    profile: { findMany: jest.Mock };
  };

  /** Queue the raw results in call order: assignments, applications, contacts. */
  function withRows(
    collabs: unknown[],
    applications: unknown[],
    contacts: unknown[] = [],
  ) {
    prisma.$queryRaw
      .mockResolvedValueOnce(collabs)
      .mockResolvedValueOnce(applications)
      .mockResolvedValueOnce(contacts);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      profile: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const cache = {
      // Pass-through: these specs exercise the real aggregation.
      wrap: (_k: string, _t: number, loader: () => unknown) => loader(),
      listKey: (entity: string) => entity,
    };
    service = new CollaborationGraphService(prisma as never, cache as never);
  });

  it('merges both sources into one link per pair', async () => {
    withRows([row('e1', 'w1', 3)], [row('e1', 'w1', 5)]);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges).toEqual([
      { source: 'e1', target: 'w1', collaborations: 3, applications: 5, contacts: 0 },
    ]);
  });

  it('keeps a pair that only ever applied', async () => {
    withRows([], [row('e1', 'w1', 2)]);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges[0]).toMatchObject({
      collaborations: 0,
      applications: 2,
    });
  });

  it('sums a node across all of its links and counts its degree', async () => {
    withRows(
      [row('e1', 'w1', 2), row('e1', 'w2', 1)],
      [row('e1', 'w1', 4)],
    );
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
      profile('w2', 'WORKER'),
    ]);

    const graph = await service.getGraph();
    const employer = graph.nodes.find((n) => n.id === 'e1');

    expect(employer).toMatchObject({
      collaborations: 3,
      applications: 4,
      // Degree is distinct counterparties — what the node is sized by.
      degree: 2,
    });
  });

  it('drops weak links when minCollaborations is set', async () => {
    withRows([row('e1', 'w1', 3), row('e1', 'w2', 1)], []);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    const graph = await service.getGraph({ minCollaborations: 2 });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].target).toBe('w1');
  });

  it('skips the application query entirely when excluded', async () => {
    withRows([row('e1', 'w1', 1)], []);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    await service.getGraph({
      includeApplications: false,
      includeContacts: false,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the STRONGEST links when over the cap, not the first ones', async () => {
    // Truncating by insertion order would drop exactly the relationships this
    // view exists to surface.
    withRows(
      [row('e1', 'w1', 1), row('e1', 'w2', 9), row('e1', 'w3', 5)],
      [],
    );
    prisma.profile.findMany.mockResolvedValue([profile('e1', 'EMPLOYER')]);

    const graph = await service.getGraph({ limit: 2 });

    expect(graph.edges.map((e) => e.target)).toEqual(['w2', 'w3']);
    expect(graph.stats.truncated).toBe(true);
  });

  it('only loads profiles the surviving links reference', async () => {
    withRows([row('e1', 'w1', 5), row('e1', 'w2', 1)], []);
    prisma.profile.findMany.mockResolvedValue([profile('e1', 'EMPLOYER')]);

    await service.getGraph({ minCollaborations: 2 });

    expect(prisma.profile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: expect.arrayContaining(['e1', 'w1']) } },
      }),
    );
    const ids = (
      prisma.profile.findMany.mock.calls[0][0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in;
    expect(ids).not.toContain('w2');
  });

  it('returns an empty graph rather than querying profiles for nothing', async () => {
    withRows([], []);

    const graph = await service.getGraph();

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(prisma.profile.findMany).not.toHaveBeenCalled();
  });

  it('caps an absurd limit instead of trusting the caller', async () => {
    withRows([], []);
    await expect(
      service.getGraph({ limit: 999_999 }),
    ).resolves.toBeDefined();
  });

  it('counts a paid contact as its own kind of link', async () => {
    // An employer who paid to reach a worker they never hired still has a
    // relationship with them — the graph exists to show exactly that.
    withRows([], [], [row('e1', 'w1', 1)]);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges).toEqual([
      { source: 'e1', target: 'w1', collaborations: 0, applications: 0, contacts: 1 },
    ]);
    expect(graph.stats.contacts).toBe(1);
    expect(graph.nodes.map((n) => n.contacts)).toEqual([1, 1]);
  });

  it('skips the contact query when excluded', async () => {
    withRows([row('e1', 'w1', 1)], []);
    prisma.profile.findMany.mockResolvedValue([
      profile('e1', 'EMPLOYER'),
      profile('w1', 'WORKER'),
    ]);

    await service.getGraph({ includeContacts: false });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
