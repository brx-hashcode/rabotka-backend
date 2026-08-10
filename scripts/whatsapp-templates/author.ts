/**
 * Write the repo-authored templates into `out/payloads/`.
 *
 * The Cloud-native counterpart to `generate.ts`: same output directory, same
 * consumer (`create.ts`), but the copy comes from `definitions.ts` instead of
 * the Twilio Content API — so this needs no Twilio credentials and can express
 * things Twilio cannot, such as a FLOW button.
 *
 * READ-ONLY against Meta. `create.ts --commit` remains the only writer.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/author.ts
 *   node_modules/.bin/tsx scripts/whatsapp-templates/author.ts --only contactUnlocked
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authoredTemplates } from './definitions';
import {
  templateCloudName,
  type WhatsAppTemplateName,
} from '../../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const PAYLOADS = path.join('scripts', 'whatsapp-templates', 'out', 'payloads');

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

function main(): void {
  fs.mkdirSync(PAYLOADS, { recursive: true });
  const only = parseOnly();

  const entries = Object.entries(authoredTemplates()).filter(
    ([key]) => !only || only.includes(key),
  );
  if (entries.length === 0) {
    console.log('Nothing selected.');
    return;
  }

  let drift = 0;
  for (const [key, payload] of entries) {
    if (!payload) continue;
    fs.writeFileSync(
      path.join(PAYLOADS, `${key}.json`),
      JSON.stringify(payload, null, 2) + '\n',
    );

    // The registry name is what a SEND resolves to. If it disagrees with what
    // is about to be submitted, the template is approved under one name and
    // asked for under another — `132001 Template name does not exist`, on the
    // first real send rather than here.
    const registryName = templateCloudName(key as WhatsAppTemplateName);
    const flag = payload.name === registryName ? 'ok' : 'NAME DRIFT';
    if (payload.name !== registryName) drift++;
    console.log(
      `${flag.padEnd(10)} ${key} -> ${payload.name}` +
        (payload.name === registryName
          ? ''
          : ` (registry says ${registryName})`),
    );
  }

  console.log(
    `\n${entries.length} payload(s) -> ${PAYLOADS}\n` +
      (drift
        ? `${drift} name mismatch(es) above — fix before submitting.\n`
        : 'Names match the registry. Nothing has been sent to Meta.\n'),
  );
}

main();
