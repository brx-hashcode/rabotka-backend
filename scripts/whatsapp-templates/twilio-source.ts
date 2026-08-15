/**
 * Reads the 27 approved templates back out of Twilio's Content API.
 *
 * Twilio is the source of truth for the copy: the bodies, button labels and
 * URLs live there, not in this repo, which only ever knew a `contentSid`.
 * Recreating them in Rabotka's own WABA is a translation of real data rather
 * than a rewrite from memory, and that is only true because this endpoint
 * exists.
 */
import {
  WHATSAPP_TEMPLATES,
  templateContentSid,
  type WhatsAppTemplateName,
} from '../../src/common/constants/whatsapp-templates';

const CONTENT_API = 'https://content.twilio.com/v1/Content';

export interface TwilioAction {
  type: string;
  title?: string;
  url?: string;
  copy_code_text?: string;
}

export interface TwilioTypeSpec {
  body?: string | null;
  title?: string | null;
  subtitle?: string | null;
  media?: string[];
  actions?: TwilioAction[];
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
}

export interface TwilioContent {
  sid: string;
  friendly_name: string;
  language: string;
  variables: Record<string, string>;
  types: Record<string, TwilioTypeSpec>;
}

export type TwilioKind =
  | 'twilio/text'
  | 'twilio/call-to-action'
  | 'twilio/card'
  | 'whatsapp/authentication';

export interface SourceTemplate {
  key: WhatsAppTemplateName;
  kind: TwilioKind;
  content: TwilioContent;
  spec: TwilioTypeSpec;
}

function authHeader(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing — this reads the approved ' +
        'templates out of Twilio, so it needs the Twilio credentials, not the Meta ones.',
    );
  }
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

export async function fetchTwilioContent(
  contentSid: string,
): Promise<TwilioContent> {
  const res = await fetch(`${CONTENT_API}/${contentSid}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(
      `Twilio Content ${contentSid} -> HTTP ${res.status}. The SID may have been ` +
        `deleted, or an env override points at something that no longer exists.`,
    );
  }
  return (await res.json()) as TwilioContent;
}

/** Every registry template, paired with its live Twilio definition. */
export async function loadAll(
  keys?: WhatsAppTemplateName[],
): Promise<SourceTemplate[]> {
  const wanted =
    keys ?? (Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[]);

  const out: SourceTemplate[] = [];
  for (const key of wanted) {
    // Cloud-only templates were authored in `definitions.ts` and have no Twilio
    // definition to read back. Skipping rather than throwing keeps a bare
    // `loadAll()` — which passes every registry key — working.
    const contentSid = templateContentSid(key);
    if (!contentSid) continue;

    const content = await fetchTwilioContent(contentSid);
    const kind = Object.keys(content.types ?? {})[0] as TwilioKind | undefined;
    if (!kind) throw new Error(`${key}: Twilio content has no type`);
    out.push({ key, kind, content, spec: content.types[kind] });
  }
  return out;
}

/** The `{{n}}` indices used in a string, in numeric order. */
export function variablesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]);
  return [...new Set(found)].sort((a, b) => Number(a) - Number(b));
}

/** The single URL action of a template, if it has one. */
export function urlAction(spec: TwilioTypeSpec): TwilioAction | undefined {
  return (spec.actions ?? []).find((a) => a.type === 'URL');
}
