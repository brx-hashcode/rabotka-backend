import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

/**
 * Every scope Rabotka knows how to satisfy.
 *
 * A scope not listed here is refused at `authorize` rather than dropped
 * silently. Dropping it would let a partner ship against a claim that never
 * arrives and only discover it from a user's bug report; refusing it fails at
 * integration time, on their screen, with the name of the scope in it.
 */
export const SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'phone',
  'email',
  'rabotka:verification',
  'rabotka:location',
] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

/**
 * What a newly registered app may ask for unless an admin widens it.
 *
 * `email` and `rabotka:location` are deliberately absent: they are real
 * personal data with no bearing on "is this a real, verified person", which is
 * the question this product exists to answer. A partner that genuinely needs
 * them has to ask an admin, and that conversation is the point.
 */
export const DEFAULT_ALLOWED_SCOPES: SupportedScope[] = [
  'openid',
  'profile',
  'phone',
  'rabotka:verification',
];

/**
 * How long an authorization code lives.
 *
 * 60s, because a code is a bearer credential travelling in a URL — through the
 * user's address bar, their history, and any Referer header the partner's
 * callback page leaks. It only has to survive one server-to-server round trip.
 * RFC 6749 §4.1.2 recommends a maximum of ten minutes; that recommendation
 * predates PKCE and predates most of what we know about how codes escape.
 */
export const AUTH_CODE_TTL_SECONDS = 60;

/**
 * How long the user has to get through the phone + OTP + consent screens.
 *
 * Generous on purpose: the OTP arrives over WhatsApp, and on the connections
 * this app runs over that is routinely a minute by itself. Shorter and the
 * failure mode is a consent screen that dies while the user is reading it.
 */
export const INTERACTION_TTL_SECONDS = 600;

/** Access token lifetime. Matches the ID token — see `oauth-token.service.ts`. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** ID token lifetime. One hour, the value this feature was specified with. */
export const ID_TOKEN_TTL_SECONDS = 3600;

/**
 * OTP attempts allowed per interaction before it is burned.
 *
 * The platform's global throttler is 100 requests/minute/IP, which is not a
 * meaningful bound on guessing a 6-digit code from a botnet. This is.
 */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * How long a rotated client secret keeps working.
 *
 * A partner cannot redeploy the instant an admin clicks "rotate", and an
 * integration that dies mid-afternoon because someone was tidying up is how
 * this feature would earn a reputation. 24h is one business day.
 */
export const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

const NS = `${REDIS_KEY_PREFIX}oauth:`;

export const OAUTH_KEYS = {
  /** The login+consent session behind an `authorize` request. */
  interaction: (id: string) => `${NS}interaction:${id}`,
  /** A minted authorization code, consumed exactly once at the token endpoint. */
  code: (code: string) => `${NS}code:${code}`,
  /** An opaque access token, good only for `/userinfo`. */
  accessToken: (token: string) => `${NS}at:${token}`,
} as const;
