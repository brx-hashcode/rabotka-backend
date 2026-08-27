import { Injectable, Logger } from '@nestjs/common';
import { OAuthApp, OAuthAppStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthError } from '../oauth-error';
import {
  clientSecretMatches,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  secretHint,
} from '../utils/client-credentials.util';
import {
  DEFAULT_ALLOWED_SCOPES,
  SECRET_ROTATION_GRACE_MS,
  SUPPORTED_SCOPES,
  type SupportedScope,
} from '../oauth.constants';
import { validateRedirectUriForRegistration } from '../utils/redirect-uri.util';

/** A freshly minted secret, returned once and never again. */
export type MintedSecret = { clientId: string; clientSecret: string };

/**
 * Registration, credential lifecycle, and client authentication for partner
 * applications.
 *
 * Registration is an admin action on purpose — there is no dynamic client
 * registration and no self-service. Rabotka is vouching for its users'
 * identities to whoever holds a `client_id`, and that is not a thing to hand
 * out to anyone who can POST.
 */
@Injectable()
export class OAuthAppService {
  private readonly logger = new Logger(OAuthAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The app behind a `client_id`, or null.
   *
   * Callers must treat "unknown app" and "suspended app" as the same outcome at
   * the authorization endpoint — both render an error page rather than
   * redirecting — so this returns the row and lets them decide, rather than
   * throwing two different errors that leak which one it was.
   */
  async findByClientId(clientId: string): Promise<OAuthApp | null> {
    if (typeof clientId !== 'string' || clientId.length === 0) return null;
    return this.prisma.oAuthApp.findFirst({
      where: { client_id: clientId, deleted_at: null },
    });
  }

  /**
   * Authenticates a partner at the token endpoint.
   *
   * Throws `invalid_client` for every failure — unknown id, wrong secret,
   * suspended app — with the same message and the same amount of work done, so
   * the response cannot be used to enumerate which `client_id`s exist.
   */
  async authenticateClient(
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthApp> {
    const app = await this.findByClientId(clientId);

    const failure = new OAuthError(
      'invalid_client',
      'Client authentication failed.',
      401,
    );

    if (!app) {
      // Hash the presented secret anyway. Returning early here would make an
      // unknown client_id measurably faster to reject than a known one with a
      // bad secret, which is exactly the enumeration oracle the uniform error
      // message above is trying to avoid.
      hashClientSecret(clientSecret ?? '');
      throw failure;
    }

    if (app.status !== OAuthAppStatus.ACTIVE) throw failure;
    if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
      throw failure;
    }

    if (clientSecretMatches(clientSecret, app.client_secret_hash)) return app;

    // The previous secret stays valid through the rotation grace window, so a
    // partner mid-redeploy authenticates on either one.
    if (
      app.previous_secret_hash &&
      app.previous_secret_expires_at &&
      app.previous_secret_expires_at.getTime() > Date.now() &&
      clientSecretMatches(clientSecret, app.previous_secret_hash)
    ) {
      this.logger.log(
        `App ${app.client_id} authenticated with its previous secret (grace window ends ${app.previous_secret_expires_at.toISOString()})`,
      );
      return app;
    }

    throw failure;
  }

  async create(params: {
    name: string;
    description: string;
    contactEmail: string;
    logoUrl?: string;
    redirectUris: string[];
    allowedScopes?: string[];
    createdBy?: string;
  }): Promise<{ app: OAuthApp; secret: MintedSecret }> {
    const redirectUris = normaliseRedirectUris(params.redirectUris);
    const allowedScopes = normaliseScopes(params.allowedScopes);

    const clientId = generateClientId();
    const clientSecret = generateClientSecret();

    const app = await this.prisma.oAuthApp.create({
      data: {
        name: params.name.trim(),
        description: params.description.trim(),
        contact_email: params.contactEmail.trim().toLowerCase(),
        logo_url: params.logoUrl?.trim() || null,
        client_id: clientId,
        client_secret_hash: hashClientSecret(clientSecret),
        client_secret_hint: secretHint(clientSecret),
        redirect_uris: redirectUris,
        allowed_scopes: allowedScopes,
        created_by: params.createdBy ?? null,
      },
    });

    return { app, secret: { clientId, clientSecret } };
  }

  async update(
    id: string,
    params: {
      name?: string;
      description?: string;
      contactEmail?: string;
      logoUrl?: string | null;
      redirectUris?: string[];
      allowedScopes?: string[];
      status?: OAuthAppStatus;
    },
  ): Promise<OAuthApp> {
    const data: Prisma.OAuthAppUpdateInput = {};

    if (params.name !== undefined) data.name = params.name.trim();
    if (params.description !== undefined) {
      data.description = params.description.trim();
    }
    if (params.contactEmail !== undefined) {
      data.contact_email = params.contactEmail.trim().toLowerCase();
    }
    if (params.logoUrl !== undefined) {
      data.logo_url = params.logoUrl?.trim() || null;
    }
    if (params.redirectUris !== undefined) {
      data.redirect_uris = normaliseRedirectUris(params.redirectUris);
    }
    if (params.allowedScopes !== undefined) {
      data.allowed_scopes = normaliseScopes(params.allowedScopes);
    }
    if (params.status !== undefined) data.status = params.status;

    return this.prisma.oAuthApp.update({ where: { id }, data });
  }

  /**
   * Issues a new secret and puts the old one on a countdown.
   *
   * The old hash is kept rather than dropped so the partner can deploy on their
   * own schedule. Rotating twice inside the grace window deliberately discards
   * the oldest secret — otherwise "rotate immediately, twice" would be the
   * obvious response to a leak and would silently keep the leaked one alive.
   */
  async rotateSecret(id: string): Promise<MintedSecret> {
    const app = await this.prisma.oAuthApp.findUniqueOrThrow({ where: { id } });
    const clientSecret = generateClientSecret();

    await this.prisma.oAuthApp.update({
      where: { id },
      data: {
        client_secret_hash: hashClientSecret(clientSecret),
        client_secret_hint: secretHint(clientSecret),
        previous_secret_hash: app.client_secret_hash,
        previous_secret_expires_at: new Date(
          Date.now() + SECRET_ROTATION_GRACE_MS,
        ),
        secret_rotated_at: new Date(),
      },
    });

    return { clientId: app.client_id, clientSecret };
  }

  /**
   * Ends the grace window immediately, for a secret believed to be leaked.
   *
   * Separate from `rotateSecret` because the two are different emergencies: a
   * routine rotation wants the overlap, a leak wants the old credential dead
   * this second even at the cost of the partner's downtime.
   */
  async revokePreviousSecret(id: string): Promise<void> {
    await this.prisma.oAuthApp.update({
      where: { id },
      data: { previous_secret_hash: null, previous_secret_expires_at: null },
    });
  }

  /**
   * What this app may actually have, given what it asked for.
   *
   * Intersection, not validation: a partner asking for a scope it was never
   * granted is a misconfiguration worth an error, but that error belongs at
   * `authorize` where the partner's developer sees it. Callers check the result
   * against the request themselves.
   */
  grantableScopes(app: OAuthApp, requested: readonly string[]): string[] {
    const allowed = new Set(app.allowed_scopes);
    return requested.filter((scope) => allowed.has(scope));
  }
}

function normaliseRedirectUris(uris: string[]): string[] {
  const cleaned = uris.map((u) => u.trim()).filter((u) => u.length > 0);

  if (cleaned.length === 0) {
    throw new OAuthError(
      'invalid_request',
      'Au moins une URI de redirection est requise.',
      400,
    );
  }

  for (const uri of cleaned) {
    const problem = validateRedirectUriForRegistration(uri);
    if (problem) {
      throw new OAuthError('invalid_request', `${uri} : ${problem}`, 400);
    }
  }

  // Deduplicated, but never reordered or rewritten: the stored strings are
  // compared byte-for-byte at authorize time, so anything this function
  // "tidies" is a redirect that will mysteriously stop matching.
  return [...new Set(cleaned)];
}

function normaliseScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return [...DEFAULT_ALLOWED_SCOPES];

  const supported = new Set<string>(SUPPORTED_SCOPES);
  const unknown = scopes.filter((s) => !supported.has(s));
  if (unknown.length > 0) {
    throw new OAuthError(
      'invalid_scope',
      `Scopes inconnus : ${unknown.join(', ')}`,
      400,
    );
  }

  // `openid` is what makes this OIDC rather than bare OAuth, and every claim
  // builder assumes a `sub`. Adding it silently is friendlier than rejecting an
  // admin who left it out of a checkbox list.
  const result = new Set<SupportedScope>(scopes as SupportedScope[]);
  result.add('openid');
  return [...result];
}
