import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ID_TOKEN_TTL_SECONDS,
  OAUTH_KEYS,
} from '../oauth.constants';
import { OAuthError } from '../oauth-error';
import { OidcKeyService, OIDC_SIGNING_ALG } from './oidc-key.service';
import {
  buildClaims,
  type ClaimSourceProfile,
  type OidcClaims,
} from '../utils/claims.util';

/** What an opaque access token resolves to. */
type AccessTokenRecord = {
  authorizationId: string;
  profileId: string;
  clientId: string;
  scopes: string[];
};

/**
 * The exact columns `buildClaims` reads.
 *
 * Shared between the token and userinfo paths so a claim can never be present
 * in one and missing from the other, and narrow so that a column added to
 * `Profile` later cannot leak into a partner's hands just by existing.
 */
const CLAIM_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
  avatar_url: true,
  city: true,
  country_code: true,
  status: true,
  verification_status: true,
  verified_at: true,
} as const;

@Injectable()
export class OAuthTokenService {
  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly keys: OidcKeyService,
  ) {}

  /** The `iss` claim, and the base of every URL in the discovery document. */
  issuer(): string {
    const configured = this.config.get<string>('OIDC_ISSUER');
    if (!configured) {
      throw new Error('OIDC_ISSUER is not set');
    }
    // Trailing slashes are a classic source of `iss` mismatches: a client
    // comparing the discovery document's issuer to the token's does a string
    // compare, and "https://x" != "https://x/".
    return configured.replace(/\/+$/, '');
  }

  /**
   * Signs the ID token — the thing the partner actually consumes.
   *
   * RS256 with a `kid`, verifiable against the published JWKS by anyone,
   * forgeable by nobody. `aud` is the `client_id`, so a token minted for one
   * partner is rejected by another even if it somehow arrives there.
   */
  async signIdToken(params: {
    claims: OidcClaims;
    clientId: string;
    nonce?: string;
    authTime: number;
  }): Promise<string> {
    const { key, kid } = this.keys.signingKey();
    const now = Math.floor(Date.now() / 1000);

    const jwt = new SignJWT({
      ...params.claims,
      // `auth_time` is when the user actually proved who they are, not when
      // this token was cut. A partner enforcing its own max session age needs
      // the former; `iat` would silently reset it on every refresh.
      auth_time: params.authTime,
      ...(params.nonce ? { nonce: params.nonce } : {}),
    })
      .setProtectedHeader({ alg: OIDC_SIGNING_ALG, kid })
      .setIssuer(this.issuer())
      .setAudience(params.clientId)
      .setSubject(String(params.claims.sub))
      .setIssuedAt(now)
      .setExpirationTime(now + ID_TOKEN_TTL_SECONDS);

    return jwt.sign(key);
  }

  /**
   * Mints an opaque access token.
   *
   * Deliberately NOT a JWT, unlike the ID token beside it. This token's only
   * job is to fetch `/userinfo`, and handing a partner two JWTs invites them to
   * verify the wrong one — or worse, to read claims out of the access token and
   * skip verification entirely because "it decoded fine". Opaque also means
   * revocation is real: deleting the Redis key kills it instantly, where a
   * self-contained JWT would stay valid for its full hour no matter what an
   * admin clicked.
   */
  async mintAccessToken(record: AccessTokenRecord): Promise<string> {
    const token = `rbk_at_${randomBytes(32).toString('base64url')}`;
    await this.redis.set(
      OAUTH_KEYS.accessToken(token),
      JSON.stringify(record),
      'EX',
      ACCESS_TOKEN_TTL_SECONDS,
    );
    return token;
  }

  async revokeAccessToken(token: string): Promise<void> {
    await this.redis.del(OAUTH_KEYS.accessToken(token));
  }

  /**
   * Resolves a bearer token to its claims, re-checking authority as it goes.
   *
   * The token being unexpired is not enough. The consent behind it may have
   * been revoked, the app suspended, or the profile banned in the meantime —
   * all of which happen on a different timescale than an hour, and all of which
   * must take effect on the next request rather than at expiry.
   */
  async resolveUserinfo(token: string): Promise<OidcClaims> {
    const raw = await this.redis.get(OAUTH_KEYS.accessToken(token));

    const invalid = new OAuthError(
      'invalid_token',
      'The access token is expired, revoked, or invalid.',
      401,
    );

    if (!raw) throw invalid;

    let record: AccessTokenRecord;
    try {
      record = JSON.parse(raw) as AccessTokenRecord;
    } catch {
      throw invalid;
    }

    const authorization = await this.prisma.oAuthAuthorization.findUnique({
      where: { id: record.authorizationId },
      include: {
        app: { select: { status: true, deleted_at: true } },
        profile: { select: CLAIM_SELECT },
      },
    });

    if (
      !authorization ||
      authorization.revoked_at !== null ||
      authorization.app.deleted_at !== null ||
      authorization.app.status !== 'ACTIVE'
    ) {
      // Drop the token too: whatever just invalidated it is not going to
      // un-invalidate itself, so leaving it in Redis only costs another
      // database round trip on every retry.
      await this.revokeAccessToken(token);
      throw invalid;
    }

    return buildClaims(
      authorization.profile,
      record.scopes,
      authorization.pairwise_sub,
    );
  }

  /** The claim-bearing columns for a profile, or null if it is gone. */
  async loadClaimSource(profileId: string): Promise<ClaimSourceProfile | null> {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, deleted_at: null },
      select: CLAIM_SELECT,
    });
    return profile;
  }
}
