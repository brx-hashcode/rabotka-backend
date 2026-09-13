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
const OUT = path.join('scripts', 'whatsapp-templates', 'out');

/**
 * The handle for a DOCUMENT header, uploaded by `upload-media.ts --out
 * document-handle.json`.
 *
 * Meta will not take a URL at creation time: it stores an EXAMPLE of the
 * document and reviewers open it, so the bytes have to be uploaded first and
 * referenced by handle. Kept in its own file rather than `media-handle.json`,
 * which `generate.ts` reads for the image cards — one file for both would put
 * a contract PDF behind every brand card.
 */
function readDocumentHandle(key?: string): string | undefined {
  // Per-template first: an agreement and a contract are different documents,
  // and a reviewer opening the example expects the one the copy describes.
  // Falls back to a shared handle when only one sample was uploaded.
  const candidates = key
    ? [`document-handle.${key}.json`, 'document-handle.json']
    : ['document-handle.json'];

  for (const name of candidates) {
    const file = path.join(OUT, name);
    if (!fs.existsSync(file)) continue;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null && 'handle' in raw) {
      return String(raw.handle);
    }
  }
  return undefined;
}

/** The literal the definitions carry until a real handle is available. */
const HANDLE_PLACEHOLDER = 'MISSING_MEDIA_HANDLE';

/**
 * Swap the placeholder for the uploaded handle.
 *
 * Returns whether the payload still carries a placeholder, so `main` can refuse
 * to pretend a template is ready to submit. A rejected submission is not free —
 * it counts against the WABA's quality rating — so this fails loudly here.
 */
function injectHandle(
  payload: { components: { example?: { header_handle?: string[] } }[] },
  handle: string | undefined,
): boolean {
  let placeholderLeft = false;
  for (const component of payload.components) {
    const handles = component.example?.header_handle;
    if (!handles?.includes(HANDLE_PLACEHOLDER)) continue;
    if (handle) {
      component.example!.header_handle = handles.map((h) =>
        h === HANDLE_PLACEHOLDER ? handle : h,
      );
    } else {
      placeholderLeft = true;
    }
  }
  return placeholderLeft;
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
  let missingHandles = 0;
  for (const [key, payload] of entries) {
    if (!payload) continue;

    if (injectHandle(payload, readDocumentHandle(key))) {
      missingHandles++;
      console.log(
        `NO HANDLE  ${key} -> needs a DOCUMENT example. Run:\n` +
          '           node_modules/.bin/tsx scripts/whatsapp-templates/upload-media.ts \\\n' +
          '             --file <sample.pdf> --out document-handle.json',
      );
    }

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

  if (missingHandles > 0) {
    console.log(
      `\n${missingHandles} payload(s) still carry ${HANDLE_PLACEHOLDER}. ` +
        'Submitting one would be rejected, and rejections count against the ' +
        "WABA's quality rating — upload a sample first.",
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
