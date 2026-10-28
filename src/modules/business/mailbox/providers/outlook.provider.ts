import {
  isCvAttachment,
  MAIL_WINDOW_DAYS,
  senderName,
} from '../cv-attachments';
import {
  fetchJson,
  MailboxAuthError,
  tokenRequest,
  type CvMail,
  type MailProviderClient,
  type ProviderTokens,
} from './mail-provider';

const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const SCOPE = 'offline_access User.Read Mail.Read';
const PAGE_SIZE = 15;

type MsToken = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};
type GraphAttachment = {
  '@odata.type': string;
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
};
type GraphMessage = {
  id: string;
  subject?: string;
  receivedDateTime: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  attachments?: GraphAttachment[];
};

/** Outlook and Microsoft 365, through Microsoft Graph (`Mail.Read`). */
export class OutlookProvider implements MailProviderClient {
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
      response_mode: 'query',
      scope: SCOPE,
      prompt: 'select_account',
      state,
    });
    return `${LOGIN}/authorize?${q.toString()}`;
  }

  private token(form: Record<string, string>) {
    return tokenRequest<MsToken>(`${LOGIN}/token`, {
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      scope: SCOPE,
      ...form,
    });
  }

  async exchange(code: string, redirectUri: string) {
    const t = await this.token({
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!t.refresh_token) throw new Error('Microsoft gave no refresh token');
    const me = await fetchJson<{ mail?: string; userPrincipalName?: string }>(
      `${GRAPH}?$select=mail,userPrincipalName`,
      { headers: { Authorization: `Bearer ${t.access_token}` } },
    );
    return {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      email: me.mail || me.userPrincipalName || '',
    };
  }

  async refresh(refreshToken: string): Promise<ProviderTokens> {
    const t = await this.token({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    return {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
    };
  }

  /** Graph has no revocation of one refresh token: the row is simply dropped. */
  async revoke(): Promise<void> {}

  async listCvMails(access: string, opts: { q?: string; page?: string }) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${access}`,
    };
    let url: string;
    if (opts.page) {
      // Graph's own next link; only ever one of ours.
      if (!opts.page.startsWith(`${GRAPH}/`)) throw new Error('Bad page link');
      url = opts.page;
    } else {
      const expand = 'attachments($select=id,name,contentType,size,isInline)';
      const select = 'id,subject,receivedDateTime,from,hasAttachments';
      const q = opts.q?.trim();
      // Graph refuses $filter with $search: a search is narrowed here instead.
      const params = q
        ? `$search=${encodeURIComponent(`"${q.replace(/"/g, '')}"`)}`
        : `$filter=${encodeURIComponent(
            `hasAttachments eq true and receivedDateTime ge ${new Date(Date.now() - MAIL_WINDOW_DAYS * 86_400_000).toISOString()}`,
          )}&$orderby=receivedDateTime desc`;
      url = `${GRAPH}/messages?${params}&$top=${PAGE_SIZE}&$select=${select}&$expand=${encodeURIComponent(expand)}`;
      if (q) headers.ConsistencyLevel = 'eventual';
    }
    const page = await fetchJson<{
      value: (GraphMessage & { hasAttachments?: boolean })[];
      '@odata.nextLink'?: string;
    }>(url, { headers });

    const since = Date.now() - MAIL_WINDOW_DAYS * 86_400_000;
    const mails: CvMail[] = [];
    for (const m of page.value) {
      if (!m.hasAttachments) continue;
      if (Date.parse(m.receivedDateTime) < since) continue;
      const attachments = (m.attachments ?? [])
        .filter(
          (a) =>
            a['@odata.type'] === '#microsoft.graph.fileAttachment' &&
            isCvAttachment({ name: a.name, size: a.size, inline: a.isInline }),
        )
        .map((a) => ({
          id: a.id,
          name: a.name,
          size: a.size,
          mime: a.contentType || 'application/octet-stream',
        }));
      if (attachments.length === 0) continue;
      const from = m.from?.emailAddress;
      mails.push({
        id: m.id,
        fromName: senderName(from?.name || from?.address),
        subject: m.subject ?? '',
        date: m.receivedDateTime,
        attachments,
      });
    }
    return { mails, next: page['@odata.nextLink'] ?? null };
  }

  async attachment(access: string, messageId: string, attachmentId: string) {
    const base = `${GRAPH}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const headers = { Authorization: `Bearer ${access}` };
    const meta = await fetchJson<GraphAttachment>(
      `${base}?$select=id,name,contentType,size`,
      { headers },
    );
    const res = await fetch(`${base}/$value`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new MailboxAuthError();
    if (!res.ok) throw new Error(`Graph attachment → ${res.status}`);
    return {
      name: meta.name,
      mime: meta.contentType || 'application/octet-stream',
      buffer: Buffer.from(await res.arrayBuffer()),
    };
  }
}
