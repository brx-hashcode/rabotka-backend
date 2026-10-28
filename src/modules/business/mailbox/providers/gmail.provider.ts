import {
  isCvAttachment,
  MAIL_WINDOW_DAYS,
  senderName,
} from '../cv-attachments';
import {
  fetchJson,
  MailboxConnectError,
  tokenRequest,
  type CvMail,
  type MailAttachment,
  type MailProviderClient,
  type ProviderTokens,
} from './mail-provider';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const PAGE_SIZE = 15;

type Part = {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number };
  parts?: Part[];
};
type Message = { id: string; internalDate?: string; payload?: Part };
type GoogleToken = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  /** What was granted: the consent screen lets each permission be unticked. */
  scope?: string;
};

/** Every attachment part of a message, however deep the multiparts nest. */
function attachmentParts(part: Part | undefined, out: Part[] = []): Part[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const p of part.parts ?? []) attachmentParts(p, out);
  return out;
}

function header(part: Part | undefined, name: string): string {
  return (
    part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  );
}

function isInline(part: Part): boolean {
  return /^inline/i.test(header(part, 'Content-Disposition'));
}

/** Gmail, read-only (`gmail.readonly`, a restricted scope: Google reviews the app). */
export class GmailProvider implements MailProviderClient {
  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
  ) {}

  get available(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      // A refresh token comes only with the consent screen.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH}?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string) {
    const t = await tokenRequest<GoogleToken>(TOKEN, {
      code,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!t.scope?.split(' ').includes(SCOPE)) {
      throw new MailboxConnectError('scope', `granted: ${t.scope ?? 'none'}`);
    }
    if (!t.refresh_token) throw new Error('Google gave no refresh token');
    const profile = await fetchJson<{ emailAddress: string }>(
      `${API}/profile`,
      { headers: { Authorization: `Bearer ${t.access_token}` } },
    );
    return {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      email: profile.emailAddress,
    };
  }

  async refresh(refreshToken: string): Promise<ProviderTokens> {
    const t = await tokenRequest<GoogleToken>(TOKEN, {
      refresh_token: refreshToken,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      grant_type: 'refresh_token',
    });
    return {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
    };
  }

  async revoke(refreshToken: string): Promise<void> {
    await fetch(`${REVOKE}?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
  }

  async listCvMails(access: string, opts: { q?: string; page?: string }) {
    const auth = { headers: { Authorization: `Bearer ${access}` } };
    const q = [
      'has:attachment',
      '{filename:pdf filename:docx filename:jpg filename:jpeg filename:png filename:webp}',
      `newer_than:${MAIL_WINDOW_DAYS}d`,
      opts.q?.trim() ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    const params = new URLSearchParams({ q, maxResults: String(PAGE_SIZE) });
    if (opts.page) params.set('pageToken', opts.page);
    const list = await fetchJson<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>(`${API}/messages?${params.toString()}`, auth);

    const fields =
      'id,internalDate,payload(headers,partId,filename,mimeType,body(attachmentId,size),' +
      'parts(partId,filename,mimeType,headers,body(attachmentId,size),' +
      'parts(partId,filename,mimeType,headers,body(attachmentId,size),' +
      'parts(partId,filename,mimeType,headers,body(attachmentId,size)))))';
    const messages = await Promise.all(
      (list.messages ?? []).map((m) =>
        fetchJson<Message>(
          `${API}/messages/${m.id}?format=full&fields=${encodeURIComponent(fields)}`,
          auth,
        ),
      ),
    );

    const mails: CvMail[] = [];
    for (const m of messages) {
      const attachments: MailAttachment[] = attachmentParts(m.payload)
        .map((p) => ({
          id: p.partId ?? '',
          name: p.filename ?? '',
          size: p.body?.size ?? 0,
          mime: p.mimeType ?? 'application/octet-stream',
          inline: isInline(p),
        }))
        .filter((a) => a.id && isCvAttachment(a))
        .map(({ inline: _inline, ...a }) => a);
      if (attachments.length === 0) continue;
      mails.push({
        id: m.id,
        fromName: senderName(header(m.payload, 'From')),
        subject: header(m.payload, 'Subject'),
        date: new Date(Number(m.internalDate ?? 0)).toISOString(),
        attachments,
      });
    }
    return { mails, next: list.nextPageToken ?? null };
  }

  async attachment(access: string, messageId: string, partId: string) {
    const auth = { headers: { Authorization: `Bearer ${access}` } };
    // Re-read the message: an attachment id is only good for the read it came from.
    const m = await fetchJson<Message>(
      `${API}/messages/${encodeURIComponent(messageId)}?format=full`,
      auth,
    );
    const part = attachmentParts(m.payload).find((p) => p.partId === partId);
    if (!part?.body?.attachmentId) throw new Error('Attachment not found');
    const data = await fetchJson<{ data: string }>(
      `${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
      auth,
    );
    return {
      name: part.filename ?? 'cv',
      mime: part.mimeType ?? 'application/octet-stream',
      buffer: Buffer.from(data.data, 'base64url'),
    };
  }
}
