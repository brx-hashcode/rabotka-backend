/**
 * Proves the v2 ranker actually personalizes: runs the real feed for every
 * worker with interaction history and reports how many distinct feeds come out.
 *
 * If the distinct-feed count is 1, the rewrite achieved nothing — every worker
 * is still seeing the same list. Run with `matching.use_embeddings='false'`
 * (the default) to confirm the SQL-only tier personalizes on its own.
 *
 * Usage: pnpm tsx scripts/check-feed-divergence.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProfileType } from '@prisma/client';
import { CandidateSourceService } from '../src/modules/recommendation-engine/candidate-sources';
import { UserFeatureService } from '../src/modules/recommendation-engine/user-feature.service';
import { RecommendationEngineService } from '../src/modules/recommendation-engine/recommendation-engine.service';

config({ path: '.env.local' });
config({ path: '.env' });

const LIMIT = 10;

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  // Deterministic: always exploit, so divergence can't be explained by chance.
  const rng = () => 0.99;
  const systemConfig = {
    // This script measures the SQL-only tier, per the usage note above, so the
    // similarity term stays off — and `similarityFor` checks this before it
    // would reach Qdrant, which is why the stub below can refuse every call.
    isSimilarityEnabled: async () => false,
    getRecommendationMinScore: async () => 0.3,
    get: async (_k: string, fallback: string) => fallback,
    getFees: async () => ({ reliabilityScoreMin: 50 }),
  };

  // Loud rather than absent: if embeddings are ever switched on here, the run
  // should say so instead of quietly scoring without the term it was measuring.
  const qdrant = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `check-feed-divergence runs with embeddings off; QdrantService.${String(prop)} was called`,
        );
      },
    },
  );

  try {
    const features = new UserFeatureService(prisma as never);
    const sources = new CandidateSourceService(
      prisma as never,
      qdrant as never,
    );
    const engine = new RecommendationEngineService(
      prisma as never,
      sources,
      features,
      systemConfig as never,
    );

    const workers = await prisma.profile.findMany({
      where: { profile_type: ProfileType.WORKER },
      select: { id: true, first_name: true },
    });

    const feeds = new Map<string, string[]>();
    const tierMix = new Map<string, number>();
    let empty = 0;

    for (const w of workers) {
      const ranked = await engine.recommendJobsForWorker(w.id, LIMIT, { rng });
      if (ranked.length === 0) {
        empty++;
        continue;
      }
      feeds.set(w.id, ranked.map((r) => r.id));
      for (const r of ranked) {
        tierMix.set(r.tier, (tierMix.get(r.tier) ?? 0) + 1);
      }
    }

    const distinct = new Set([...feeds.values()].map((f) => JSON.stringify(f)));
    const topOnly = new Set([...feeds.values()].map((f) => f[0]));

    console.log(`workers scanned .......... ${workers.length}`);
    console.log(`empty feeds .............. ${empty}`);
    console.log(`distinct full feeds ...... ${distinct.size} / ${feeds.size}`);
    console.log(`distinct top results ..... ${topOnly.size} / ${feeds.size}`);
    console.log('\ntier mix (higher tiers dominating means the ranker is idle):');
    for (const [tier, n] of [...tierMix].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tier.padEnd(10)} ${n}`);
    }

    // ── Employer side ────────────────────────────────────────────────────────
    const employers = await prisma.profile.findMany({
      where: { profile_type: ProfileType.EMPLOYER },
      select: { id: true },
    });

    const wFeeds = new Map<string, string[]>();
    const wTierMix = new Map<string, number>();
    let wEmpty = 0;

    for (const e of employers) {
      const ranked = await engine.recommendWorkersForEmployer(e.id, 20, { rng });
      if (ranked.length === 0) {
        wEmpty++;
        continue;
      }
      wFeeds.set(e.id, ranked.map((r) => r.id));
      for (const r of ranked) {
        wTierMix.set(r.tier, (wTierMix.get(r.tier) ?? 0) + 1);
      }
    }

    const wDistinct = new Set([...wFeeds.values()].map((f) => JSON.stringify(f)));
    console.log(`\nemployers scanned ........ ${employers.length}`);
    console.log(`empty worker feeds ....... ${wEmpty}`);
    console.log(`distinct worker feeds .... ${wDistinct.size} / ${wFeeds.size}`);
    console.log('worker-feed tier mix:');
    for (const [tier, n] of [...wTierMix].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tier.padEnd(10)} ${n}`);
    }

    // Score spread — a ranker whose scores are all identical isn't ranking.
    const sample = workers[0];
    if (sample) {
      const ranked = await engine.recommendJobsForWorker(sample.id, LIMIT, {
        rng,
      });
      console.log(`\nsample feed for ${sample.first_name ?? sample.id}:`);
      for (const r of ranked) {
        console.log(`  ${r.score.toFixed(4)}  ${r.tier.padEnd(10)} ${r.id}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
