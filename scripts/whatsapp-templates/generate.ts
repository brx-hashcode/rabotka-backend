/**
 * Generate Meta `message_templates` payloads from the approved Twilio templates.
 *
 * READ-ONLY. Reads Twilio, writes JSON to disk, touches Meta not at all.
 * `create.ts --commit` is the only thing that submits anything.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts
 *   node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts --only statusCheck,otp
 *
 * Outputs, all under scripts/whatsapp-templates/out/:
 *   payloads/<key>.json   the exact body create.ts will POST
 *   fixtures.json         the raw Twilio definitions, so the translation tests
 *                         run offline against real data
 *   report.md             a human-readable diff of what will be submitted
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAll } from './twilio-source';
import { translate } from './translate';
import type { WhatsAppTemplateName } from '../../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const OUT = path.join('scripts', 'whatsapp-templates', 'out');
const PAYLOADS = path.join(OUT, 'payloads');

function parseOnly(): WhatsAppTemplateName[] | undefined {
  const flag = process.argv.find((a) => a.startsWith('--only'));
  if (!flag) return undefined;
  const value = flag.includes('=')
    ? flag.split('=')[1]
    : process.argv[process.argv.indexOf(flag) + 1];
  return value?.split(',').map((s) => s.trim()) as
    | WhatsAppTemplateName[]
    | undefined;
}

function readMediaHandle(): string | undefined {
  const file = path.join(OUT, 'media-handle.json');
  if (!fs.existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'handle' in parsed) {
    const handle = (parsed as { handle?: unknown }).handle;
    return typeof handle === 'string' ? handle : undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  fs.mkdirSync(PAYLOADS, { recursive: true });

  const only = parseOnly();
  const mediaHandle = readMediaHandle();
  if (!mediaHandle) {
    console.log(
      'No media handle yet — card templates will be generated with a placeholder.\n' +
        'Run upload-media.ts before create.ts, then regenerate.\n',
    );
  }

  const sources = await loadAll(only);
  const translations = sources.map((s) => translate(s, { mediaHandle }));

  const rows: string[] = [];
  let issueCount = 0;

  for (const t of translations) {
    fs.writeFileSync(
      path.join(PAYLOADS, `${t.key}.json`),
      JSON.stringify(t.payload, null, 2) + '\n',
    );
    const shapes = t.payload.components.map((c) => c.type).join('+');
    const drift =
      t.payload.name === t.registryName
        ? ''
        : ` (registry says \`${t.registryName}\`)`;
    rows.push(
      `| \`${t.key}\` | \`${t.payload.name}\`${drift} | ${t.payload.category} | ${shapes} |`,
    );
    for (const i of t.issues) {
      issueCount++;
      console.log(`ISSUE  ${i.key}: ${i.problem}`);
    }
  }

  // Fixtures let the translation tests run against real Twilio data with no
  // network — the alternative is either a mock that can drift from reality, or
  // a test suite that needs credentials.
  fs.writeFileSync(
    path.join(OUT, 'fixtures.json'),
    JSON.stringify(
      sources.map((s) => ({ key: s.key, kind: s.kind, content: s.content })),
      null,
      2,
    ) + '\n',
  );

  const drifted = translations.filter((t) => t.payload.name !== t.registryName);

  const report = [
    '# Meta template payloads — generated, not yet submitted',
    '',
    `Source: Twilio Content API. Generated ${new Date().toISOString()}.`,
    `${translations.length} templates, ${issueCount} issue(s).`,
    '',
    '| key | Meta name | category | components |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## Names',
    '',
    'Names come from the live Twilio `friendly_name`, not the registry defaults —',
    'those were derived from the key before anything could be checked against a',
    `real account. ${drifted.length} of ${translations.length} disagree, so the`,
    "registry's `cloud.name` defaults need updating to match once these are",
    'approved. `emit-env.ts` prints the overrides for anything still mismatched.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), report);

  console.log(
    `\n${translations.length} payload(s) -> ${PAYLOADS}\n` +
      `report -> ${path.join(OUT, 'report.md')}\n` +
      `fixtures -> ${path.join(OUT, 'fixtures.json')}\n` +
      (issueCount
        ? `\n${issueCount} issue(s) above. Nothing has been sent to Meta.\n`
        : '\nNo issues. Nothing has been sent to Meta.\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
