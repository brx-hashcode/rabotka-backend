/**
 * Minimal Graph client for the template-management endpoints.
 *
 * Separate from `src/modules/whatsapp/providers/cloud/cloud.client.ts` on
 * purpose: that one is the SEND path, tuned for latency and deliberately
 * retry-free because BullMQ owns retries there. This is an operator tool
 * talking to a different endpoint with different concerns.
 */
export interface MetaError {
  code: number;
  error_subcode?: number;
  message: string;
  error_user_title?: string;
  error_user_msg?: string;
}

export interface MetaTemplateSummary {
  id: string;
  name: string;
  status: string;
  category?: string;
  language?: string;
  rejected_reason?: string;
}

function credentials(): { waba: string; token: string; appId?: string } {
  const waba = process.env.WHATSAPP_CLOUD_WABA_ID;
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!waba || !token) {
    throw new Error(
      'WHATSAPP_CLOUD_WABA_ID / WHATSAPP_CLOUD_ACCESS_TOKEN missing from the environment.',
    );
  }
  return { waba, token, appId: process.env.WHATSAPP_CLOUD_APP_ID };
}

export function apiVersion(): string {
  return process.env.WHATSAPP_CLOUD_API_VERSION ?? 'v25.0';
}

/**
 * Turn a Graph failure into something an operator can act on.
 *
 * `error_user_msg` is the field Meta puts the actionable text in — "Template
 * name already exists", "Invalid parameter" — and it is easy to miss under the
 * generic `message`.
 */
export function describeError(err: MetaError): string {
  const parts = [
    `[${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''}]`,
  ];
  if (err.error_user_title) parts.push(err.error_user_title + ':');
  parts.push(err.error_user_msg ?? err.message);
  if (err.code === 190) {
    parts.push('\n  -> the access token expired; generate a new one.');
  }
  return parts.join(' ');
}

async function graph<T>(
  path: string,
  init: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: MetaError }> {
  const { token } = credentials();
  const res = await fetch(
    `https://graph.facebook.com/${apiVersion()}/${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error: MetaError }).error
        : { code: res.status, message: res.statusText };
    return { ok: false, error };
  }
  return { ok: true, data: body as T };
}

export async function listTemplates(): Promise<MetaTemplateSummary[]> {
  const { waba } = credentials();
  const out: MetaTemplateSummary[] = [];
  let path =
    `${waba}/message_templates?limit=200` +
    `&fields=id,name,status,category,language,rejected_reason`;

  // Paginate: a full Rabotka WABA is 27+ templates across languages, and Graph
  // caps a page well below what a silent single-page read would suggest.
  for (;;) {
    const res = await graph<{
      data: MetaTemplateSummary[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(path, { method: 'GET' });
    if (!res.ok) throw new Error(describeError(res.error));
    out.push(...(res.data.data ?? []));
    const after = res.data.paging?.cursors?.after;
    if (!res.data.paging?.next || !after) break;
    path =
      `${waba}/message_templates?limit=200&after=${after}` +
      `&fields=id,name,status,category,language,rejected_reason`;
  }
  return out;
}

export async function createTemplate(
  payload: unknown,
): Promise<
  { ok: true; data: MetaTemplateSummary } | { ok: false; error: MetaError }
> {
  const { waba } = credentials();
  return graph<MetaTemplateSummary>(`${waba}/message_templates`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
