/**
 * Fills in `latitude`/`longitude` for profiles that have none.
 *
 * Profiles were only ever geocoded at creation, fire-and-forget, and never
 * re-geocoded on an address change — so anyone who existed before that path, or
 * whose geocode failed, has NULL coordinates. Every distance-weighted ranking
 * term silently falls back to a neutral value for those users, which reads as
 * "recommendations ignore where I live".
 *
 * Nominatim is rate-limited to ~1 req/s, so this is deliberately slow and
 * resumable: it only touches rows that are still NULL.
 *
 * Usage:
 *   pnpm tsx prisma/backfill-profile-geocode.ts [--dry-run] [--limit=200]
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number(
  process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 500,
);

/** Nominatim asks for ≤1 request/second and a real User-Agent. */
const RATE_LIMIT_MS = 1100;
const CITY_HINT = 'Brazzaville Congo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function geocode(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  const needsHint = !/brazzaville|congo/i.test(address);
  const q = needsHint ? `${address}, ${CITY_HINT}` : address;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'rabotka-geocode-backfill/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat: string; lon: string }[];
    const hit = data[0];
    if (!hit) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const [total, missing] = await Promise.all([
      prisma.profile.count({ where: { deleted_at: null } }),
      prisma.profile.count({
        where: { deleted_at: null, OR: [{ latitude: null }, { longitude: null }] },
      }),
    ]);
    const covered = total - missing;
    console.log(
      `Coverage before: ${covered}/${total} (${total ? ((covered / total) * 100).toFixed(1) : '0'}%)`,
    );

    // `address` is non-nullable on Profile, so only the coordinates need testing.
    const targets = await prisma.profile.findMany({
      where: {
        deleted_at: null,
        OR: [{ latitude: null }, { longitude: null }],
      },
      select: { id: true, address: true },
      take: LIMIT,
    });
    console.log(`${targets.length} profile(s) to geocode (limit ${LIMIT}).`);

    if (DRY_RUN) {
      for (const t of targets.slice(0, 10)) {
        console.log(`  ${t.id} — ${t.address}`);
      }
      console.log('\n--dry-run: nothing written.');
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const [i, t] of targets.entries()) {
      if (!t.address) continue;
      const coords = await geocode(t.address);
      if (coords) {
        await prisma.profile.update({
          where: { id: t.id },
          data: { latitude: coords.lat, longitude: coords.lng },
        });
        ok++;
      } else {
        failed++;
      }
      if ((i + 1) % 25 === 0) {
        console.log(`  …${i + 1}/${targets.length} (${ok} ok, ${failed} failed)`);
      }
      await sleep(RATE_LIMIT_MS);
    }

    const stillMissing = await prisma.profile.count({
      where: { deleted_at: null, OR: [{ latitude: null }, { longitude: null }] },
    });
    console.log(
      `\nGeocoded ${ok}, failed ${failed}. Coverage now: ${total - stillMissing}/${total}.`,
    );
    if (failed > 0) {
      console.log(
        'Failures are usually unrecognisable free-text addresses — safe to re-run later.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
