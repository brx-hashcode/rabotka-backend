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
  templateCloudName,
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

/**
 * The name to LOOK UP at Meta, and whether the local payload disagrees with it.
 *
 * `out/payloads/` is gitignored, so it is a per-machine artifact of the last
 * `author.ts`/`generate.ts` run — not a record of what the app sends. Reading
 * the name from it alone is what let `kycPendingMenu` report v3 APPROVED for
 * weeks while every send asked for v4 and got `132001`.
 *
 * So the REGISTRY wins, since that is what a send resolves to, and a stale
 * payload is called out rather than silently believed. `verify.ts` is the
 * check that fails a deploy over it; this one only has to stop lying.
 */
function lookupName(
  key: WhatsAppTemplateName,
  submitted: Map<WhatsAppTemplateName, string>,
): { name: string; stalePayload?: string } {
  const registryName = templateCloudName(key);
  const payloadName = submitted.get(key);
  return payloadName && payloadName !== registryName
    ? { name: registryName, stalePayload: payloadName }
    : { name: registryName };
}

function render(live: MetaTemplateSummary[]): boolean {
  const byName = new Map(live.map((t) => [t.name, t]));
  const names = submittedNames();
  const keys = Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[];

  const counts: Record<string, number> = {};
  let allSettled = true;

  console.log('');
  for (const key of keys) {
    const { name, stalePayload } = lookupName(key, names);
    const found = byName.get(name);
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
    // The local payload names a different template than the one the app sends.
    // Almost always: `definitions.ts` was bumped and `author.ts` never re-run,
    // so nothing was ever submitted under the new name.
    const stale = stalePayload
      ? `  <-- local payload still says ${stalePayload}`
      : '';

    console.log(
      `  ${status.padEnd(14)} ${key.padEnd(30)} ${name.padEnd(42)}${drift}${why}${stale}`,
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
