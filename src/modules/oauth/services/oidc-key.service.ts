import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  importPKCS8,
  importSPKI,
  exportJWK,
  type JWK,
  type KeyObject,
} from 'jose';

/**
 * The signing algorithm, fixed.
 *
 * RS256 rather than the HS256 used everywhere else in this codebase, and the
 * difference is the whole reason this service exists. Every existing Rabotka
 * token is symmetric under one shared `JWT_SECRET`: anyone who can verify one
 * can mint one, and the only thing separating a profile session from an admin
 * session is a `type` field. Partners must be able to verify an ID token
 * without being able to forge anything, so the IdP gets its own asymmetric
 * keypair that touches nothing else.
 */
export const OIDC_SIGNING_ALG = 'RS256';

type LoadedKey = { kid: string; publicJwk: JWK };

/**
 * Loads the OIDC keypair once at boot and publishes the public half as a JWKS.
 *
 * Keys come from the environment rather than from `SystemConfig`, which is
 * where every other runtime secret in this app lives. `SystemConfig` is
 * editable from the admin UI, and a private key that an admin can paste over is
 * a private key that will eventually be pasted over — taking every partner
 * integration down at once, with no obvious cause.
 */
@Injectable()
export class OidcKeyService implements OnModuleInit {
  private readonly logger = new Logger(OidcKeyService.name);

  private privateKey!: KeyObject;
  private current!: LoadedKey;
  /**
   * The key we no longer sign with but still publish.
   *
   * Rotation is otherwise a cliff: the moment a new key is installed, every ID
   * token already in a partner's hands fails verification, and partners cache
   * the JWKS. Publishing both for one token lifetime makes the changeover a
   * non-event.
   */
  private previous: LoadedKey | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const pem = decodePem(this.config.get<string>('OIDC_PRIVATE_KEY'));
    const kid = this.config.get<string>('OIDC_KEY_ID');

    if (!pem || !kid) {
      // Fail at boot, not at the first partner login. A missing key here means
      // `/token` returns 500 for everyone, and discovering that from a
      // partner's support email is the worst possible way to find out.
      throw new Error(
        'OIDC_PRIVATE_KEY and OIDC_KEY_ID must be set — "Login with Rabotka" cannot sign ID tokens without them.',
      );
    }

    // `extractable: true` is required, not optional: jose imports keys as
    // non-extractable by default, and `exportJWK` on such a key throws. The
    // public half of the JWKS is derived from this key below, so without it the
    // app cannot boot at all.
    this.privateKey = await importPKCS8(pem, OIDC_SIGNING_ALG, {
      extractable: true,
    });

    // The public half is derived from the private key rather than configured
    // separately, so the two can never disagree.
    this.current = {
      kid,
      publicJwk: toPublicJwk(await exportJWK(this.privateKey), kid),
    };

    await this.loadPreviousKey();

    this.logger.log(
      `OIDC signing key loaded (kid=${kid}${this.previous ? `, previous kid=${this.previous.kid}` : ''})`,
    );
  }

  /** The key to sign with, and the `kid` to stamp into the JWS header. */
  signingKey(): { key: KeyObject; kid: string } {
    return { key: this.privateKey, kid: this.current.kid };
  }

  /**
   * The document at `/.well-known/jwks.json`.
   *
   * Current key first: verifiers that ignore `kid` and try keys in order — and
   * there are more of those than there should be — then succeed on the first
   * attempt for every token still being issued.
   */
  jwks(): { keys: JWK[] } {
    const keys = [this.current.publicJwk];
    if (this.previous) keys.push(this.previous.publicJwk);
    return { keys };
  }

  private async loadPreviousKey(): Promise<void> {
    const pem = decodePem(this.config.get<string>('OIDC_PUBLIC_KEY_PREVIOUS'));
    const kid = this.config.get<string>('OIDC_KEY_ID_PREVIOUS');
    if (!pem || !kid) return;

    try {
      const key = await importSPKI(pem, OIDC_SIGNING_ALG, {
        extractable: true,
      });
      this.previous = {
        kid,
        publicJwk: toPublicJwk(await exportJWK(key), kid),
      };
    } catch (err) {
      // A malformed previous key must not stop the app from booting: it only
      // affects tokens that are at most an hour from expiry anyway, and taking
      // the whole API down over it would be a far worse outcome than letting
      // those few verifications fail.
      this.logger.warn(
        `OIDC_PUBLIC_KEY_PREVIOUS could not be loaded, serving one key only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Reduces a JWK to the fields that are safe to publish. **Allowlist, never a
 * denylist.**
 *
 * `exportJWK` on a private key returns the PRIVATE JWK — for RSA that is `d`,
 * `p`, `q`, `dp`, `dq` and `qi` alongside the public `n` and `e`. Spreading
 * that object into the JWKS would publish Rabotka's signing key at a public,
 * cache-friendly, CORS-open URL, and anyone who fetched it could mint an ID
 * token asserting any identity to any partner. It is the single worst bug this
 * feature could ship, and it is one `...spread` away at all times.
 *
 * Written as a positive list of the three public RSA fields so that it fails
 * closed: a future key type whose fields are not named here produces an
 * unusable JWKS entry, which is a loud, harmless failure. A denylist of
 * "remove `d`" would instead fail open the moment anything changes.
 */
function toPublicJwk(jwk: JWK, kid: string): JWK {
  return {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    kid,
    alg: OIDC_SIGNING_ALG,
    use: 'sig',
  };
}

/**
 * Accepts a PEM either literally or base64-encoded.
 *
 * A PEM is multi-line, and multi-line values do not survive most of the places
 * these are pasted — Coolify's env editor, GitHub Actions secrets, a
 * `docker-compose` file. Base64 is what actually arrives intact; the literal
 * form stays supported because it is what a developer will try first locally.
 */
function decodePem(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return decoded.includes('-----BEGIN') ? decoded : null;
  } catch {
    return null;
  }
}
