import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthApp, OAuthAppStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthError } from '../oauth-error';
import { OAuthAppService } from './oauth-app.service';
import { OAuthCodeService } from './oauth-code.service';
import {
  OAuthInteractionService,
  type OAuthInteraction,
} from './oauth-interaction.service';
import { isRegisteredRedirectUri } from '../utils/redirect-uri.util';
import { isValidCodeChallenge } from '../utils/pkce.util';
import { canAuthenticateToPartner } from '../utils/claims.util';
import { derivePairwiseSub } from '../utils/client-credentials.util';
import { SUPPORTED_SCOPES } from '../oauth.constants';

/** The raw query string of an `authorize` request, before any validation. */
export type AuthorizeRequest = {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  prompt?: string;
};

/** What the consent screen needs to render itself. */
export type ConsentContext = {
  app: { name: string; description: string; logoUrl: string | null };
  scopes: string[];
  /** Null until the user has authenticated inside this interaction. */
  profile: { firstName: string; lastName: string; phoneHint: string } | null;
  /** True when a prior grant already covers every requested scope. */
  alreadyGranted: boolean;
};

@Injectable()
export class OAuthAuthorizationService {
  private readonly logger = new Logger(OAuthAuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly apps: OAuthAppService,
    private readonly interactions: OAuthInteractionService,
    private readonly codes: OAuthCodeService,
  ) {}

  /**
   * Validates an `authorize` request and opens an interaction for it.
   *
   * The order of checks here is the security-critical part, and it follows OIDC
   * Core §3.1.2.6 rather than convenience. Until BOTH the `client_id` and the
   * `redirect_uri` have been established as registered, nothing may be
   * redirected anywhere — an error redirect to an unvalidated URI is precisely
   * the open redirector that makes an authorization endpoint dangerous. Those
   * two failures throw without a `redirectUri` and get rendered on Rabotka's
   * own error page. Everything after them is the partner developer's bug and is
   * reported back to the partner, where they will actually see it.
   */
  async beginAuthorization(
    query: AuthorizeRequest,
    existingProfileId: string | null,
  ): Promise<{ interactionId: string }> {
    // ---- Phase 1: nothing may redirect anywhere. ----
    const clientId = query.client_id;
    if (!clientId) {
      throw new OAuthError('invalid_request', 'client_id is required.', 400);
    }

    const app = await this.apps.findByClientId(clientId);
    if (!app || app.status !== OAuthAppStatus.ACTIVE) {
      // One message for "unknown" and "suspended" alike. A partner whose app
      // was suspended learns why from the admin who suspended it, not from an
      // endpoint that would also tell strangers which client_ids are real.
      throw new OAuthError(
        'unauthorized_client',
        "Cette application n'est pas autorisée à utiliser « Connexion avec Rabotka ».",
        400,
      );
    }

    const redirectUri = query.redirect_uri;
    if (
      !redirectUri ||
      !isRegisteredRedirectUri(redirectUri, app.redirect_uris)
    ) {
      throw new OAuthError(
        'invalid_request',
        "L'URI de redirection ne correspond à aucune URI enregistrée pour cette application.",
        400,
      );
    }

    // ---- Phase 2: the redirect URI is trusted; report failures to it. ----
    const state = query.state;
    const fail = (error: OAuthError) => error.redirectingTo(redirectUri, state);

    if (query.response_type !== 'code') {
      throw fail(
        new OAuthError(
          'unsupported_response_type',
          'Only response_type=code is supported.',
        ),
      );
    }

    // PKCE for every client, confidential ones included. OAuth 2.1 makes this
    // mandatory, and a confidential client's secret does not protect the code
    // in transit through the browser — only the verifier does.
    if (query.code_challenge_method !== 'S256') {
      throw fail(
        new OAuthError(
          'invalid_request',
          'code_challenge_method=S256 is required (PKCE is mandatory).',
        ),
      );
    }

    if (!isValidCodeChallenge(query.code_challenge)) {
      throw fail(
        new OAuthError(
          'invalid_request',
          'code_challenge must be the base64url-encoded SHA-256 of your code_verifier (43 characters).',
        ),
      );
    }

    const requested = parseScopes(query.scope);
    if (!requested.includes('openid')) {
      throw fail(
        new OAuthError('invalid_scope', 'The openid scope is required.'),
      );
    }

    const unknown = requested.filter(
      (s) => !(SUPPORTED_SCOPES as readonly string[]).includes(s),
    );
    if (unknown.length > 0) {
      throw fail(
        new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(', ')}`),
      );
    }

    const granted = this.apps.grantableScopes(app, requested);
    const refused = requested.filter((s) => !granted.includes(s));
    if (refused.length > 0) {
      // Refused rather than quietly dropped: a partner that asked for
      // `rabotka:verification` and was never granted it would otherwise ship,
      // read `undefined`, and treat every user as unverified.
      throw fail(
        new OAuthError(
          'invalid_scope',
          `This application is not permitted to request: ${refused.join(', ')}`,
        ),
      );
    }

    const interactionId = await this.interactions.create({
      appId: app.id,
      clientId: app.client_id,
      redirectUri,
      scopes: granted,
      state,
      nonce: query.nonce,
      codeChallenge: query.code_challenge,
      profileId: existingProfileId,
      authTime: existingProfileId ? Math.floor(Date.now() / 1000) : undefined,
    });

    return { interactionId };
  }

  /** What the consent screen renders, for an interaction in any state. */
  async consentContext(interactionId: string): Promise<ConsentContext> {
    const interaction = await this.interactions.require(interactionId);
    const app = await this.prisma.oAuthApp.findUniqueOrThrow({
      where: { id: interaction.appId },
      select: { name: true, description: true, logo_url: true },
    });

    let profile: ConsentContext['profile'] = null;
    let alreadyGranted = false;

    if (interaction.profileId) {
      const row = await this.prisma.profile.findFirst({
        where: { id: interaction.profileId, deleted_at: null },
        select: { first_name: true, last_name: true, phone: true },
      });

      if (row) {
        profile = {
          firstName: row.first_name,
          lastName: row.last_name,
          phoneHint: maskPhone(row.phone),
        };
        alreadyGranted = await this.hasStandingGrant(
          interaction.appId,
          interaction.profileId,
          interaction.scopes,
        );
      }
    }

    return {
      app: {
        name: app.name,
        description: app.description,
        logoUrl: app.logo_url,
      },
      scopes: interaction.scopes,
      profile,
      alreadyGranted,
    };
  }

  /**
   * Whether this person has already agreed to everything being asked for.
   *
   * Scope-aware rather than a boolean "has consented before": an app that later
   * starts asking for the phone number must show the consent screen again, even
   * to a user who approved it a year ago for less.
   */
  async hasStandingGrant(
    appId: string,
    profileId: string,
    requestedScopes: readonly string[],
  ): Promise<boolean> {
    const authorization = await this.prisma.oAuthAuthorization.findUnique({
      where: {
        idx_oauth_authorization_app_profile: {
          app_id: appId,
          profile_id: profileId,
        },
      },
      select: { scopes: true, revoked_at: true },
    });

    if (!authorization || authorization.revoked_at !== null) return false;

    const held = new Set(authorization.scopes);
    return requestedScopes.every((scope) => held.has(scope));
  }

  /**
   * Records consent and mints the code the partner will redeem.
   *
   * The `OAuthAuthorization` row is upserted before the code exists, so a
   * crash between the two costs the user a re-consent rather than leaving a
   * redeemable code pointing at a grant that was never written down.
   */
  async approve(interactionId: string): Promise<{ redirectTo: string }> {
    const interaction = await this.interactions.require(interactionId);

    if (!interaction.profileId) {
      throw new OAuthError(
        'login_required',
        'Authentifiez-vous avant de valider le partage.',
        401,
      );
    }

    const app = await this.requireActiveApp(interaction.appId, interaction);

    const profile = await this.prisma.profile.findFirst({
      where: { id: interaction.profileId, deleted_at: null },
      select: { id: true, status: true },
    });

    if (!profile || !canAuthenticateToPartner(profile.status)) {
      throw new OAuthError(
        'access_denied',
        'Ce compte ne peut pas être utilisé pour se connecter à une application partenaire.',
        403,
        interaction.redirectUri,
        interaction.state,
      );
    }

    const salt = this.pairwiseSalt();
    const pairwiseSub = derivePairwiseSub(app.id, profile.id, salt);

    const existing = await this.prisma.oAuthAuthorization.findUnique({
      where: {
        idx_oauth_authorization_app_profile: {
          app_id: app.id,
          profile_id: profile.id,
        },
      },
      select: { scopes: true, revoked_at: true },
    });

    /**
     * Union with what was already granted, rather than replacing it.
     *
     * An app that asks for fewer scopes on a later login — because the partner
     * trimmed their integration, or because one screen of theirs needs less —
     * must not silently revoke access the user already agreed to; the user
     * agreed to it, and taking it back is the revoke button's job, not a side
     * effect of a login. The exception is a revoked grant: consenting again
     * after a revocation starts from exactly what is on the screen now.
     */
    const scopes =
      existing && existing.revoked_at === null
        ? [...new Set([...existing.scopes, ...interaction.scopes])]
        : [...interaction.scopes];

    const authorization = await this.prisma.oAuthAuthorization.upsert({
      where: {
        idx_oauth_authorization_app_profile: {
          app_id: app.id,
          profile_id: profile.id,
        },
      },
      create: {
        app_id: app.id,
        profile_id: profile.id,
        pairwise_sub: pairwiseSub,
        scopes,
      },
      update: {
        scopes: { set: scopes },
        // Re-consenting is how a user un-revokes an app they previously cut off.
        revoked_at: null,
      },
      select: { id: true },
    });

    const authTime = interaction.authTime ?? Math.floor(Date.now() / 1000);

    const code = await this.codes.mint({
      appId: app.id,
      clientId: app.client_id,
      profileId: profile.id,
      redirectUri: interaction.redirectUri,
      scopes: interaction.scopes,
      codeChallenge: interaction.codeChallenge,
      nonce: interaction.nonce,
      authTime,
    });

    // The interaction has done its job. Dropping it here is what stops a second
    // POST to /consent from minting a second code for the same login.
    await this.interactions.destroy(interactionId);

    this.logger.log(
      `Authorization granted: app=${app.client_id} authorization=${authorization.id} scopes=[${interaction.scopes.join(' ')}]`,
    );

    return {
      redirectTo: buildRedirect(interaction.redirectUri, {
        code,
        state: interaction.state,
      }),
    };
  }

  /** The user said no. The partner is told so in the way the spec defines. */
  async deny(interactionId: string): Promise<{ redirectTo: string }> {
    const interaction = await this.interactions.require(interactionId);
    await this.interactions.destroy(interactionId);

    return {
      redirectTo: buildRedirect(interaction.redirectUri, {
        error: 'access_denied',
        error_description: "L'utilisateur a refusé le partage.",
        state: interaction.state,
      }),
    };
  }

  /**
   * Re-checks the app at consent time.
   *
   * The app was ACTIVE when `authorize` ran, but that was up to ten minutes ago
   * and an admin may have suspended it since — often precisely because
   * something is wrong with it. Ten minutes is long enough for that to matter.
   */
  private async requireActiveApp(
    appId: string,
    interaction: OAuthInteraction,
  ): Promise<OAuthApp> {
    const app = await this.prisma.oAuthApp.findFirst({
      where: { id: appId, deleted_at: null },
    });

    if (!app || app.status !== OAuthAppStatus.ACTIVE) {
      throw new OAuthError(
        'unauthorized_client',
        "Cette application n'est plus autorisée.",
        400,
        interaction.redirectUri,
        interaction.state,
      );
    }

    return app;
  }

  private pairwiseSalt(): string {
    const salt = this.config.get<string>('OIDC_PAIRWISE_SALT');
    if (!salt) {
      // Failing loudly beats deriving a `sub` from an empty salt: that would
      // succeed, look correct, and silently make every partner's user ids
      // computable by anyone who knows the two uuids.
      throw new Error('OIDC_PAIRWISE_SALT is not set');
    }
    return salt;
  }
}

function parseScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).filter((s) => s.length > 0))];
}

/**
 * Appends parameters to the partner's redirect URI.
 *
 * `URL` rather than string concatenation because a registered redirect URI is
 * allowed to carry its own query string, and `?code=` would then produce two
 * `?` in one URL — the second silently becoming part of the first parameter's
 * value.
 */
function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** `+237 6XX XX XX 42` → `••42`. Enough to recognise, not enough to disclose. */
function maskPhone(phone: string): string {
  return `••${phone.slice(-2)}`;
}
