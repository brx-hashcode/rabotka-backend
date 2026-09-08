/**
 * Create and publish the Rabotka feedback Flow.
 *
 * A WhatsApp Flow is a native form rendered inside the chat — here a star
 * rating and a comment. Built through the Graph API rather than Flow Builder so
 * the definition lives in the repo next to the code that reads its answers,
 * and so recreating it in another WABA is one command.
 *
 * `navigate` mode with a terminal screen, NOT `data_exchange`: the latter needs
 * an encrypted RSA/AES endpoint and buys nothing for a static form. The answers
 * come back on the webhook as an `nfm_reply`.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-flows/create-feedback-flow.ts            # plan
 *   node_modules/.bin/tsx scripts/whatsapp-flows/create-feedback-flow.ts --commit
 *
 * A published Flow CANNOT be edited — only deprecated and replaced. That is why
 * this refuses to touch one that already exists.
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

config({ path: '.env.local' });
config({ path: '.env' });

const FLOW_NAME = 'rabotka_feedback';
const DEFINITION = path.join('scripts', 'whatsapp-flows', 'feedback-flow.json');
const OUT = path.join('scripts', 'whatsapp-flows', 'out');

function creds(): { waba: string; token: string; version: string } {
  const waba = process.env.WHATSAPP_CLOUD_WABA_ID;
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!waba || !token)
    throw new Error('WHATSAPP_CLOUD_WABA_ID / _ACCESS_TOKEN missing');
  return {
    waba,
    token,
    version: process.env.WHATSAPP_CLOUD_API_VERSION ?? 'v25.0',
  };
}

interface GraphError {
  code: number;
  message: string;
  error_user_msg?: string;
}

async function graph<T>(
  pathname: string,
  init: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: GraphError }> {
  const { token, version } = creds();
  const res = await fetch(`https://graph.facebook.com/${version}/${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error: GraphError }).error
        : { code: res.status, message: res.statusText };
    return { ok: false, error };
  }
  return { ok: true, data: body as T };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const { waba } = creds();
  const definition: unknown = JSON.parse(fs.readFileSync(DEFINITION, 'utf8'));

  const existing = await graph<{
    data: { id: string; name: string; status: string }[];
  }>(`${waba}/flows?fields=id,name,status`, { method: 'GET' });
  if (!existing.ok)
    throw new Error(`Could not list flows: ${existing.error.message}`);

  const already = existing.data.data?.find((f) => f.name === FLOW_NAME);
  if (already) {
    console.log(
      `"${FLOW_NAME}" already exists: ${already.id} (${already.status}).\n` +
        'A published Flow cannot be edited — deprecate it and use a new name.',
    );
    return;
  }

  if (!commit) {
    console.log(
      `PLAN — would create and publish "${FLOW_NAME}" in WABA ${waba}\n` +
        `  definition: ${DEFINITION}\n` +
        `  screens:    ${(definition as { screens?: unknown[] }).screens?.length ?? 0}\n\n` +
        'Nothing sent. Re-run with --commit.\n',
    );
    return;
  }

  // 1. The Flow shell.
  const created = await graph<{ id: string }>(`${waba}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: FLOW_NAME,
      categories: ['SURVEY'],
    }),
  });
  if (!created.ok) {
    throw new Error(
      `Create failed: ${created.error.error_user_msg ?? created.error.message}`,
    );
  }
  const flowId = created.data.id;
  console.log(`created ${flowId}`);

  // 2. The definition, uploaded as an asset. Multipart, and the file part must
  //    be named `file` with asset_type FLOW_JSON.
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append(
    'file',
    new Blob([JSON.stringify(definition)], { type: 'application/json' }),
    'flow.json',
  );
  const asset = await graph<{
    success: boolean;
    validation_errors?: unknown[];
  }>(`${flowId}/assets`, { method: 'POST', body: form });
  if (!asset.ok) {
    throw new Error(
      `Asset upload failed: ${asset.error.error_user_msg ?? asset.error.message}`,
    );
  }
  if (asset.data.validation_errors?.length) {
    console.log('validation errors:');
    console.log(JSON.stringify(asset.data.validation_errors, null, 2));
    throw new Error('Definition rejected — fix feedback-flow.json and retry.');
  }
  console.log('definition uploaded');

  // 3. Publish. Draft flows can only be sent to the account's own testers.
  const published = await graph<{ success: boolean }>(`${flowId}/publish`, {
    method: 'POST',
  });
  if (!published.ok) {
    throw new Error(
      `Publish failed: ${published.error.error_user_msg ?? published.error.message}`,
    );
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'feedback-flow.json'),
    JSON.stringify(
      { flowId, name: FLOW_NAME, publishedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\npublished ${flowId}\n\n` +
      `Set this in the environment:\n  WHATSAPP_FEEDBACK_FLOW_ID=${flowId}\n`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
