/**
 * Submit generated payloads to Meta for approval.
 *
 * THE ONLY SCRIPT HERE THAT WRITES. Dry-run unless `--commit` is passed, so
 * running it by accident prints a plan and stops.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/create.ts                       # plan only
 *   node_modules/.bin/tsx scripts/whatsapp-templates/create.ts --only statusCheck    # plan one
 *   node_modules/.bin/tsx scripts/whatsapp-templates/create.ts --only statusCheck --commit
 *
 * Submissions are not free of consequence: repeated rejections count against
 * the WABA's quality rating, which is why the plan advises a pilot of three
 * before the remaining twenty-four.
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTemplate, describeError, listTemplates } from './meta-client';

config({ path: '.env.local' });
config({ path: '.env' });

const PAYLOADS = path.join('scripts', 'whatsapp-templates', 'out', 'payloads');
const RESULTS = path.join(
  'scripts',
  'whatsapp-templates',
  'out',
  'created.json',
);

interface Payload {
  name: string;
  language: string;
  category: string;
  components: { type: string }[];
}

function parseOnly(): string[] | undefined {
  const i = process.argv.findIndex(
    (a) => a === '--only' || a.startsWith('--only='),
  );
  if (i === -1) return undefined;
  const raw = process.argv[i].includes('=')
    ? process.argv[i].split('=')[1]
    : process.argv[i + 1];
  return raw
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadPayloads(only?: string[]): { key: string; payload: Payload }[] {
  if (!fs.existsSync(PAYLOADS)) {
    throw new Error(`No payloads at ${PAYLOADS} — run generate.ts first.`);
  }
  return fs
    .readdirSync(PAYLOADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((key) => !only || only.includes(key))
    .map((key) => ({
      key,
      payload: JSON.parse(
        fs.readFileSync(path.join(PAYLOADS, `${key}.json`), 'utf8'),
      ) as Payload,
    }));
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const only = parseOnly();
  const selected = loadPayloads(only);

  if (selected.length === 0) {
    console.log('Nothing selected.');
    return;
  }

  // A name that already exists is rejected by Meta anyway; catching it here
  // keeps a re-run from filling the log with failures that mean "already done".
  const existing = new Set((await listTemplates()).map((t) => t.name));
  const todo = selected.filter((s) => !existing.has(s.payload.name));
  const skipped = selected.filter((s) => existing.has(s.payload.name));

  for (const s of skipped) {
    console.log(
      `SKIP    ${s.key.padEnd(30)} ${s.payload.name} (already in WABA)`,
    );
  }

  const placeholders = todo.filter((s) =>
    JSON.stringify(s.payload).includes('MISSING_MEDIA_HANDLE'),
  );
  if (placeholders.length) {
    console.log(
      `\n${placeholders.length} payload(s) still carry MISSING_MEDIA_HANDLE: ` +
        placeholders.map((p) => p.key).join(', ') +
        '\nRun upload-media.ts, then generate.ts again. Refusing to submit these.\n',
    );
  }
  const submittable = todo.filter((s) => !placeholders.includes(s));

  if (!commit) {
    console.log(`\nPLAN — would submit ${submittable.length} template(s):\n`);
    for (const s of submittable) {
      const shapes = s.payload.components.map((c) => c.type).join('+');
      console.log(
        `  ${s.key.padEnd(30)} ${s.payload.name.padEnd(42)} ${s.payload.category.padEnd(15)} ${shapes}`,
      );
    }
    console.log('\nNothing sent. Re-run with --commit to submit.\n');
    return;
  }

  const results: Record<string, unknown> = fs.existsSync(RESULTS)
    ? (JSON.parse(fs.readFileSync(RESULTS, 'utf8')) as Record<string, unknown>)
    : {};

  let ok = 0;
  let failed = 0;
  for (const s of submittable) {
    const res = await createTemplate(s.payload);
    if (res.ok) {
      ok++;
      console.log(
        `OK      ${s.key.padEnd(30)} ${s.payload.name} -> ${res.data.status ?? 'SUBMITTED'}`,
      );
      results[s.key] = {
        name: s.payload.name,
        id: res.data.id,
        status: res.data.status,
        submittedAt: new Date().toISOString(),
      };
    } else {
      failed++;
      console.log(`FAILED  ${s.key.padEnd(30)} ${describeError(res.error)}`);
      results[s.key] = {
        name: s.payload.name,
        error: describeError(res.error),
        submittedAt: new Date().toISOString(),
      };
      // Auth failures affect every subsequent call, so stop rather than
      // printing the same error twenty-six more times.
      if (res.error.code === 190) {
        console.log('\nStopping: the access token is not valid.\n');
        break;
      }
    }
  }

  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
  console.log(
    `\n${ok} submitted, ${failed} failed, ${skipped.length} already present.\n` +
      `Results -> ${RESULTS}\n` +
      'Approval is asynchronous. Run status.ts to see verdicts.\n',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
