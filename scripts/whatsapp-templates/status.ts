/**
 * What Meta has done with each submitted template.
 *
 * READ-ONLY. Run it after create.ts; approval is asynchronous and takes
 * anywhere from a minute to a few hours.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/status.ts
 *   node_modules/.bin/tsx scripts/whatsapp-templates/status.ts --watch
 */
import { config } from 'dotenv';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateName,
} from '../../src/common/constants/whatsapp-templates';
import { listTemplates, type MetaTemplateSummary } from './meta-client';
import * as fs from 'node:fs';
import * as path from 'node:path';

config({ path: '.env.local' });
config({ path: '.env' });

const PAYLOADS = path.join('scripts', 'whatsapp-templates', 'out', 'payloads');

/** key -> the name we submitted it under, taken from the generated payloads. */
function submittedNames(): Map<WhatsAppTemplateName, string> {
  const map = new Map<WhatsAppTemplateName, string>();
  if (!fs.existsSync(PAYLOADS)) return map;
  for (const file of fs
    .readdirSync(PAYLOADS)
    .filter((f) => f.endsWith('.json'))) {
    const key = file.replace(/\.json$/, '') as WhatsAppTemplateName;
    const payload = JSON.parse(
      fs.readFileSync(path.join(PAYLOADS, file), 'utf8'),
    ) as { name: string };
    map.set(key, payload.name);
  }
  return map;
}

function render(live: MetaTemplateSummary[]): boolean {
  const byName = new Map(live.map((t) => [t.name, t]));
  const names = submittedNames();
  const keys = Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[];

  const counts: Record<string, number> = {};
  let allSettled = true;

  console.log('');
  for (const key of keys) {
    const name = names.get(key);
    const found = name ? byName.get(name) : undefined;
    const status = found?.status ?? 'NOT SUBMITTED';
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === 'PENDING' || status === 'IN_APPEAL') allSettled = false;

    // Meta reclassifies on submission and does not warn: a UTILITY template
    // approved as MARKETING is priced differently and can be blocked by a
    // user's marketing opt-out.
    const intended = WHATSAPP_TEMPLATES[key].category;
    const actual = found?.category;
    const drift =
      actual && actual !== intended ? `  <-- ${intended} -> ${actual}` : '';
    const why = found?.rejected_reason ? `  (${found.rejected_reason})` : '';

    console.log(
      `  ${status.padEnd(14)} ${key.padEnd(30)} ${(name ?? '-').padEnd(42)}${drift}${why}`,
    );
  }

  console.log(
    '\n  ' +
      Object.entries(counts)
        .map(([s, n]) => `${s}: ${n}`)
        .join('   ') +
      '\n',
  );
  return allSettled;
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  for (;;) {
    const settled = render(await listTemplates());
    if (!watch || settled) return;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
