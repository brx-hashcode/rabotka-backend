/**
 * Upload the card cover to Meta and record the handle the templates need.
 *
 * The three card templates carry an IMAGE header, and Meta will not accept a
 * URL at template-creation time — it wants a handle from the Resumable Upload
 * API, which is a different endpoint on the APP (not the WABA) and a two-step
 * dance: start a session, then upload the bytes.
 *
 * Writes out/media-handle.json, which generate.ts embeds. Run it once; the
 * handle is reusable across all three cards because they share one cover.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/upload-media.ts
 *   node_modules/.bin/tsx scripts/whatsapp-templates/upload-media.ts --url <override>
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coverImageUrl } from '../../src/common/constants/whatsapp-carousel';
import { apiVersion } from './meta-client';

config({ path: '.env.local' });
config({ path: '.env' });

const OUT = path.join('scripts', 'whatsapp-templates', 'out');

function appId(): string {
  const id = process.env.WHATSAPP_CLOUD_APP_ID;
  if (id) return id;
  throw new Error(
    'WHATSAPP_CLOUD_APP_ID is not set. The resumable upload runs against the ' +
      'APP, not the WABA — find it at Meta app -> Paramètres de l’app -> Général.',
  );
}

function token(): string {
  const t = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!t) throw new Error('WHATSAPP_CLOUD_ACCESS_TOKEN is not set.');
  return t;
}

function sourceUrl(): string {
  const i = process.argv.indexOf('--url');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return coverImageUrl();
}

async function main(): Promise<void> {
  const url = sourceUrl();
  console.log(`Source: ${url}`);

  const img = await fetch(url);
  if (!img.ok) {
    throw new Error(
      `Cover image is not reachable (HTTP ${img.status}). Meta fetches nothing ` +
        `here — we upload the bytes — so a broken URL fails now rather than at ` +
        `template review.`,
    );
  }
  const bytes = Buffer.from(await img.arrayBuffer());
  const type = img.headers.get('content-type') ?? 'image/jpeg';
  console.log(`Fetched ${bytes.length} bytes (${type})`);

  // Step 1: open an upload session.
  const startRes = await fetch(
    `https://graph.facebook.com/${apiVersion()}/${appId()}/uploads` +
      `?file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token()}` } },
  );
  const start: unknown = await startRes.json();
  if (
    !startRes.ok ||
    typeof start !== 'object' ||
    start === null ||
    !('id' in start)
  ) {
    throw new Error(`Could not start upload: ${JSON.stringify(start)}`);
  }
  const sessionId = (start as { id: string }).id;
  console.log(`Session: ${sessionId}`);

  // Step 2: upload the bytes. `file_offset: 0` means "from the beginning" —
  // this is a resumable protocol and the header is not optional.
  const upRes = await fetch(
    `https://graph.facebook.com/${apiVersion()}/${sessionId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token()}`,
        file_offset: '0',
        'Content-Type': type,
      },
      body: new Uint8Array(bytes),
    },
  );
  const up: unknown = await upRes.json();
  if (!upRes.ok || typeof up !== 'object' || up === null || !('h' in up)) {
    throw new Error(`Upload failed: ${JSON.stringify(up)}`);
  }
  const handle = (up as { h: string }).h;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'media-handle.json'),
    JSON.stringify(
      {
        handle,
        sourceUrl: url,
        bytes: bytes.length,
        uploadedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\nHandle stored -> ${path.join(OUT, 'media-handle.json')}\n\n` +
      'Next:\n' +
      '  node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts\n' +
      '  node_modules/.bin/tsx scripts/whatsapp-templates/create.ts --commit\n',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
