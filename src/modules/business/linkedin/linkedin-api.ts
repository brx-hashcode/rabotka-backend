/**
 * LinkedIn, as a business's team member posts its offers on it: « Sign In with
 * LinkedIn using OpenID Connect » (who they are) and « Share on LinkedIn »
 * (`w_member_social`, a post on their own feed). Plain fetch; no SDK.
 *
 * The real LinkedIn Jobs listings (`simpleJobPostings`) are for approved
 * partners only: a post linking to the offer's careers page is what any app
 * may publish, and the candidates apply there.
 */

const AUTH = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
/** The versioned REST API (`/rest/*`) answers only to a version it still supports. */
export const LINKEDIN_VERSION = '202603';
export const LINKEDIN_SCOPE = 'openid profile w_member_social';

/** LinkedIn refused the token (expired, revoked): the member connects again. */
export class LinkedinAuthError extends Error {
  constructor(message = 'LinkedIn refused the token') {
    super(message);
    this.name = 'LinkedinAuthError';
  }
}

/** Worth another try later: LinkedIn's rate limit or its own outage. */
export class LinkedinRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedinRetryableError';
  }
}

export function linkedinAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPE,
  });
  return `${AUTH}?${q.toString()}`;
}

export type LinkedinToken = { accessToken: string; expiresAt: Date };
export type LinkedinMember = {
  sub: string;
  name: string;
  picture: string | null;
};

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 401) return new LinkedinAuthError(`${what}: ${body}`);
  if (res.status === 429 || res.status >= 500) {
    return new LinkedinRetryableError(`${what}: ${res.status} ${body}`);
  }
  return new Error(`${what}: ${res.status} ${body}`);
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<LinkedinToken> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure(res, 'Token exchange');
  const t = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: t.access_token,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
  };
}

export async function fetchMember(
  accessToken: string,
): Promise<LinkedinMember> {
  const res = await fetch(`${API}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure(res, 'Userinfo');
  const u = (await res.json()) as {
    sub: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
  };
  const name =
    u.name?.trim() ||
    [u.given_name, u.family_name].filter(Boolean).join(' ').trim() ||
    'LinkedIn';
  return { sub: u.sub, name, picture: u.picture ?? null };
}

const restHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  'LinkedIn-Version': LINKEDIN_VERSION,
  'X-Restli-Protocol-Version': '2.0.0',
  'Content-Type': 'application/json',
});

/**
 * The card's picture, uploaded to LinkedIn (a post cannot point at an image
 * URL): initializeUpload gives an upload address and the image's URN.
 */
export async function uploadImage(
  accessToken: string,
  authorUrn: string,
  png: Buffer,
): Promise<string> {
  const init = await fetch(`${API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!init.ok) throw await failure(init, 'Image upload (init)');
  const { value } = (await init.json()) as {
    value: { uploadUrl: string; image: string };
  };
  const put = await fetch(value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: new Uint8Array(png),
    signal: AbortSignal.timeout(30_000),
  });
  if (!put.ok) throw await failure(put, 'Image upload (put)');
  return value.image;
}

/**
 * LinkedIn's « little text »: these characters mean markup in a post's
 * commentary and must be escaped to show as typed. Hashtags written with `#`
 * become real LinkedIn hashtags; links stay as written, so LinkedIn makes
 * them clickable.
 */
export function toLittleText(text: string): string {
  const escape = (t: string) =>
    t.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
  const token = /(https?:\/\/\S+)|#([\p{L}\p{N}_]+)/gu;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(token)) {
    out +=
      escape(text.slice(last, m.index)) + (m[1] ?? `{hashtag|\\#|${m[2]}}`);
    last = m.index + m[0].length;
  }
  return out + escape(text.slice(last));
}

/**
 * The text always says where to apply: the careers link is added at the end
 * when the recruiter's text no longer has it (an image post has no link card).
 */
export function withApplyLink(text: string, url: string): string {
  const path = new URL(url).pathname;
  if (text.includes(path)) return text.trim();
  return `${text.trim()}\n\n👉 Postulez en ligne : ${url}`;
}

export type SharePost = {
  authorUrn: string;
  text: string;
  /** The offer's careers page, where candidates apply. */
  url: string;
  title: string;
  description: string;
  /** urn:li:image:… shown large; without one, a link card. */
  image: string | null;
};

/**
 * The post: the text (with the link to apply) above the offer's picture,
 * shown large. Without a picture, a card that opens the careers page.
 */
export function postBody(p: SharePost) {
  return {
    author: p.authorUrn,
    commentary: toLittleText(withApplyLink(p.text, p.url)),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: p.image
      ? { media: { id: p.image, altText: p.title.slice(0, 300) } }
      : {
          article: {
            source: p.url,
            title: p.title.slice(0, 200),
            description: p.description.slice(0, 250),
          },
        },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/** Publishes; the post's URN comes back in the `x-restli-id` header. */
export async function createPost(
  accessToken: string,
  post: SharePost,
): Promise<string> {
  const res = await fetch(`${API}/rest/posts`, {
    method: 'POST',
    headers: restHeaders(accessToken),
    body: JSON.stringify(postBody(post)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await failure(res, 'Create post');
  const urn = res.headers.get('x-restli-id');
  if (!urn) throw new Error('Create post: no x-restli-id');
  return urn;
}

/**
 * Where an uploaded picture can be seen (a signed, expiring address): to show
 * the recruiter the picture its post carries.
 */
export async function imageDownloadUrl(
  accessToken: string,
  imageUrn: string,
): Promise<string | null> {
  const res = await fetch(
    `${API}/rest/images/${encodeURIComponent(imageUrn)}`,
    { headers: restHeaders(accessToken), signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { downloadUrl?: string };
  return body.downloadUrl ?? null;
}

/** Where a post is read: its URN in a feed link. */
export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
}
