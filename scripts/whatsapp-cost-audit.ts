/**
 * Where the WhatsApp bill actually goes, per template.
 *
 * READ-ONLY. Answers the only question worth asking before changing a
 * template: which ones cost money, and how much of that is avoidable.
 *
 * It reads OUR OWN LOG, not Meta's analytics, because the log is per-template
 * and Meta's is not. `pricing_category` and `billable` are written straight
 * from the delivery webhook (`whatsapp-message-log.service.ts`), so they are
 * Meta's verdict rather than our intention — `template_category` is the
 * intention, and the two disagreeing is itself a finding.
 *
 * The distinction that matters is not UTILITY vs MARKETING. It is BILLABLE vs
 * not: a UTILITY template delivered inside an open 24h service window is free,
 * while a MARKETING one is charged wherever it lands. So a template whose sends
 * are all in-window is paying for nothing but its own category.
 *
 * Run it against production — a dev database has no webhooks and therefore no
 * pricing at all, which reads as "nothing is billable".
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-cost-audit.ts
 *   node_modules/.bin/tsx scripts/whatsapp-cost-audit.ts --days 30
 */
// `.env.local` first, matching `envFilePath` in app.module.ts.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

interface Row {
  template_key: string | null;
  template_category: string | null;
  pricing_category: string | null;
  billable: boolean | null;
  sends: bigint;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : value.padStart(width);
}

async function main() {
  const days = arg('days', 90);

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT template_key, template_category, pricing_category, billable,
            COUNT(*)::bigint AS sends
       FROM whatsapp_messages
      WHERE direction = 'OUTBOUND'
        AND created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY 1, 2, 3, 4`,
    String(days),
  );

  if (rows.length === 0) {
    console.log(`Aucun message sortant sur ${days} jours.`);
    return;
  }

  // Fold the four-way grouping down to one line per template.
  const byTemplate = new Map<
    string,
    {
      declared: Set<string>;
      metaSaid: Set<string>;
      total: number;
      billable: number;
      free: number;
      unknown: number;
    }
  >();

  for (const row of rows) {
    // A send with no template key is free-form text; it has no category and
    // cannot be recategorized, so it is worth seeing but not per-template.
    const key = row.template_key ?? '(texte libre)';
    const entry = byTemplate.get(key) ?? {
      declared: new Set<string>(),
      metaSaid: new Set<string>(),
      total: 0,
      billable: 0,
      free: 0,
      unknown: 0,
    };
    const n = Number(row.sends);
    entry.total += n;
    if (row.template_category) entry.declared.add(row.template_category);
    if (row.pricing_category) entry.metaSaid.add(row.pricing_category);
    // `billable` is null until the delivery webhook lands — undelivered or
    // still in flight. Counting it as free would understate the bill.
    if (row.billable === true) entry.billable += n;
    else if (row.billable === false) entry.free += n;
    else entry.unknown += n;
    byTemplate.set(key, entry);
  }

  const ranked = [...byTemplate.entries()].sort(
    (a, b) => b[1].billable - a[1].billable || b[1].total - a[1].total,
  );

  console.log(
    `\nConsommation WhatsApp par template — ${days} derniers jours\n`,
  );
  console.log(
    `${pad('TEMPLATE', 34)}${pad('DÉCLARÉ', 16)}${pad('META', 16)}` +
      `${padLeft('ENVOIS', 8)}${padLeft('FACTURÉS', 10)}${padLeft('GRATUITS', 10)}${padLeft('INCONNU', 9)}`,
  );
  console.log('-'.repeat(103));

  let totalBillable = 0;
  let totalSends = 0;

  for (const [key, e] of ranked) {
    totalBillable += e.billable;
    totalSends += e.total;
    const declared = [...e.declared].join(',') || '—';
    const meta = [...e.metaSaid].join(',') || '—';
    // Meta's verdict differing from ours is the drift `status.ts` reports for
    // templates; here it shows up on messages actually sent.
    const drift =
      e.declared.size &&
      e.metaSaid.size &&
      declared.toUpperCase() !== meta.toUpperCase()
        ? '  <-- écart'
        : '';
    console.log(
      `${pad(key, 34)}${pad(declared, 16)}${pad(meta, 16)}` +
        `${padLeft(String(e.total), 8)}${padLeft(String(e.billable), 10)}` +
        `${padLeft(String(e.free), 10)}${padLeft(String(e.unknown), 9)}${drift}`,
    );
  }

  console.log('-'.repeat(103));
  console.log(
    `${pad('TOTAL', 66)}${padLeft(String(totalSends), 8)}${padLeft(String(totalBillable), 10)}\n`,
  );

  const marketing = ranked.filter(([, e]) =>
    [...e.metaSaid, ...e.declared].some((c) => c.toUpperCase() === 'MARKETING'),
  );
  if (marketing.length > 0) {
    console.log('Facturés au tarif MARKETING (le plus cher) :');
    for (const [key, e] of marketing) {
      console.log(
        `  ${pad(key, 34)} ${padLeft(String(e.billable), 7)} facturés`,
      );
    }
    console.log('');
  }

  if (totalBillable === 0) {
    console.log(
      'Aucun message facturé : soit la base est un environnement de dev sans\n' +
        'webhooks de livraison, soit la fenêtre choisie ne contient rien.\n',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
