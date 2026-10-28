/** One attachment of a listed mail, enough to tick it and fetch it later. */
export type MailAttachment = {
  /** Gmail: the part id (its attachment ids change on each read); Outlook: the attachment id. */
  id: string;
  name: string;
  size: number;
  mime: string;
};

/** A mail with at least one CV attachment, as the business sees it. */
export type CvMail = {
  id: string;
  /** The sender's name, never the address. */
  fromName: string;
  subject: string;
  date: string;
  attachments: MailAttachment[];
};

export type ProviderTokens = {
  access: string;
  /** Some refreshes hand a new refresh token (Outlook); keep it when they do. */
  refresh?: string;
  expiresAt: Date;
};

/** The provider refused the refresh token: the mailbox must be connected again. */
export class MailboxAuthError extends Error {
  constructor(message = 'Mailbox authorization refused') {
    super(message);
    this.name = 'MailboxAuthError';
  }
}

/** A mail service the CVs are read from, by OAuth. */
export interface MailProviderClient {
  /** Whether its OAuth app is configured (client id and secret). */
  readonly available: boolean;
  authUrl(state: string, redirectUri: string): string;
  /** The code from the consent screen, for tokens and the account's address. */
  exchange(
    code: string,
    redirectUri: string,
  ): Promise<ProviderTokens & { refresh: string; email: string }>;
  refresh(refreshToken: string): Promise<ProviderTokens>;
  /** Best effort: some providers have no revocation for a refresh token. */
  revoke(refreshToken: string): Promise<void>;
  listCvMails(
    access: string,
    opts: { q?: string; page?: string },
  ): Promise<{ mails: CvMail[]; next: string | null }>;
  attachment(
    access: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ name: string; mime: string; buffer: Buffer }>;
}

/** fetch, then JSON; a 401 is the token's fault, anything else the call's. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new MailboxAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${init.method ?? 'GET'} ${url.split('?')[0]} → ${res.status} ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

/** An OAuth token endpoint: `invalid_grant` means the refresh token is gone. */
export async function tokenRequest<T>(
  url: string,
  form: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (body.error === 'invalid_grant' || res.status === 401) {
      throw new MailboxAuthError(body.error);
    }
    throw new Error(`Token endpoint → ${res.status} ${body.error ?? ''}`);
  }
  return body;
}
