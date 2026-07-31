import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AdminCacheService,
  ADMIN_LIST_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';

export type GraphNode = {
  id: string;
  name: string;
  type: 'WORKER' | 'EMPLOYER';
  avatarUrl: string | null;
  /** Missions actually worked together, summed over this node's edges. */
  collaborations: number;
  /** Applications that never became a mission. */
  applications: number;
  /** Number of distinct counterparties — what the node is sized by. */
  degree: number;
};

export type GraphEdge = {
  source: string;
  target: string;
  collaborations: number;
  applications: number;
};

export type CollaborationGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    profiles: number;
    edges: number;
    collaborations: number;
    applications: number;
    truncated: boolean;
  };
};

export type GraphQuery = {
  /** Drop edges below this many collaborations. 0 keeps application-only links. */
  minCollaborations?: number;
  /** Include the faint applied-but-never-worked edges. */
  includeApplications?: boolean;
  /** Safety cap on edges returned; the densest are kept. */
  limit?: number;
};

const DEFAULT_EDGE_LIMIT = 2000;
const MAX_EDGE_LIMIT = 10000;

type EdgeRow = { employer_id: string; worker_id: string; count: bigint };

/**
 * Builds the employer↔worker network.
 *
 * Neither Application nor Assignment links two profiles directly — both point at
 * a JobOffer, and the employer hangs off that. So every edge is a two-hop join,
 * aggregated in SQL rather than by loading rows: the row count grows with total
 * platform activity, while the answer only ever has one entry per *pair*.
 */
@Injectable()
export class CollaborationGraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
  ) {}

  async getGraph(query: GraphQuery = {}): Promise<CollaborationGraph> {
    const minCollaborations = Math.max(0, query.minCollaborations ?? 0);
    const includeApplications = query.includeApplications ?? true;
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_EDGE_LIMIT),
      MAX_EDGE_LIMIT,
    );

    const key = this.cache.listKey('collaboration-graph', {
      minCollaborations,
      includeApplications,
      limit,
    });

    return this.cache.wrap(key, ADMIN_LIST_TTL_SECONDS, () =>
      this.loadGraph({ minCollaborations, includeApplications, limit }),
    );
  }

  private async loadGraph(opts: {
    minCollaborations: number;
    includeApplications: boolean;
    limit: number;
  }): Promise<CollaborationGraph> {
    const [collabRows, applicationRows] = await Promise.all([
      // A confirmed Assignment is the only record that means "these two actually
      // worked together" — an application on its own does not.
      this.prisma.$queryRaw<EdgeRow[]>`
        SELECT jo.employer_id AS employer_id,
               a.worker_id    AS worker_id,
               COUNT(*)       AS count
        FROM "assignments" a
        JOIN "job_offers" jo ON jo.id = a.job_offer_id
        WHERE jo.deleted_at IS NULL
        GROUP BY jo.employer_id, a.worker_id
      `,
      // "Applied but never worked": anti-join against assignments, so an
      // application that became a mission is counted once (as a collaboration)
      // rather than twice.
      opts.includeApplications
        ? this.prisma.$queryRaw<EdgeRow[]>`
            SELECT jo.employer_id AS employer_id,
                   ap.worker_id   AS worker_id,
                   COUNT(*)       AS count
            FROM "applications" ap
            JOIN "job_offers" jo ON jo.id = ap.job_offer_id
            LEFT JOIN "assignments" asg ON asg.application_id = ap.id
            WHERE ap.deleted_at IS NULL
              AND jo.deleted_at IS NULL
              AND asg.id IS NULL
            GROUP BY jo.employer_id, ap.worker_id
          `
        : Promise.resolve<EdgeRow[]>([]),
    ]);

    const edges = this.mergeEdges(collabRows, applicationRows);
    const kept = this.selectEdges(edges, opts.minCollaborations, opts.limit);
    const nodes = await this.buildNodes(kept);

    return {
      nodes,
      edges: kept,
      stats: {
        profiles: nodes.length,
        edges: kept.length,
        collaborations: kept.reduce((sum, e) => sum + e.collaborations, 0),
        applications: kept.reduce((sum, e) => sum + e.applications, 0),
        truncated: kept.length < edges.length,
      },
    };
  }

  /** One entry per employer↔worker pair, carrying both counts. */
  private mergeEdges(
    collaborations: EdgeRow[],
    applications: EdgeRow[],
  ): GraphEdge[] {
    const byPair = new Map<string, GraphEdge>();

    const upsert = (row: EdgeRow, field: 'collaborations' | 'applications') => {
      const key = `${row.employer_id}|${row.worker_id}`;
      const existing = byPair.get(key) ?? {
        source: row.employer_id,
        target: row.worker_id,
        collaborations: 0,
        applications: 0,
      };
      existing[field] += Number(row.count);
      byPair.set(key, existing);
    };

    for (const row of collaborations) upsert(row, 'collaborations');
    for (const row of applications) upsert(row, 'applications');

    return [...byPair.values()];
  }

  /**
   * Filters, then keeps the strongest links when over the cap — truncating by
   * insertion order would silently drop the very relationships the view exists
   * to show.
   */
  private selectEdges(
    edges: GraphEdge[],
    minCollaborations: number,
    limit: number,
  ): GraphEdge[] {
    const filtered = edges.filter(
      (e) => e.collaborations >= minCollaborations,
    );
    if (filtered.length <= limit) return filtered;

    return [...filtered]
      .sort(
        (a, b) =>
          b.collaborations - a.collaborations ||
          b.applications - a.applications,
      )
      .slice(0, limit);
  }

  /** Loads only the profiles the surviving edges actually reference. */
  private async buildNodes(edges: GraphEdge[]): Promise<GraphNode[]> {
    const ids = new Set<string>();
    for (const e of edges) {
      ids.add(e.source);
      ids.add(e.target);
    }
    if (ids.size === 0) return [];

    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        profile_type: true,
        avatar_url: true,
      },
    });

    const totals = new Map<
      string,
      { collaborations: number; applications: number; degree: number }
    >();
    for (const e of edges) {
      for (const id of [e.source, e.target]) {
        const t = totals.get(id) ?? {
          collaborations: 0,
          applications: 0,
          degree: 0,
        };
        t.collaborations += e.collaborations;
        t.applications += e.applications;
        t.degree += 1;
        totals.set(id, t);
      }
    }

    return profiles.map((p) => {
      const t = totals.get(p.id);
      return {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        type: p.profile_type as GraphNode['type'],
        avatarUrl: p.avatar_url,
        collaborations: t?.collaborations ?? 0,
        applications: t?.applications ?? 0,
        degree: t?.degree ?? 0,
      };
    });
  }
}
