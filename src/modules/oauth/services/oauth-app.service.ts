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
  IDENTITY_CHECK_SCOPE,
  REGISTRABLE_SCOPES,
  SECRET_ROTATION_GRACE_MS,
  type RegistrableScope,
} from '../oauth.constants';
import { validateRedirectUriForRegistration } from '../utils/redirect-uri.util';
import { validateWebhookUrl } from '../utils/webhook-url.util';

/** A freshly minted secret, returned once and never again. */
export type MintedSecret = { clientId: string; clientSecret: string };

/**
 * An app row as this service hands it out.
 *
 * `sandbox_client_secret_plaintext` is omitted globally in `PrismaService`, so
 * it is absent from every result at RUNTIME. That omission does not narrow
 * Prisma's own types — `PrismaService extends PrismaClient` without passing the
 * options as a type argument — so this alias is what carries the guarantee into
 * the type system: every consumer of this service works with a shape that has
 * no such field to read.
 *
 * The single query that needs the value asks for it by name, in
 * `readSandboxSecret`.
 */
export type OAuthAppRow = Omit<OAuthApp, 'sandbox_client_secret_plaintext'>;

/**
 * The outcome of asking for a sandbox app's secret.
 *
 * A discriminated result rather than an exception: this service throws
 * `OAuthError`, which `oauth-exception.filter.ts` renders in the OAuth protocol
 * shape — wrong for an admin JSON endpoint. Returning the outcome also lets the
 * controller audit each refusal reason separately.
 *
 * Note that no branch but `ok` carries a secret field at all. A controller bug
 * that reads `clientSecret` without checking `status` is then a type error
 * rather than a disclosure.
 */
export type SandboxSecretResult =
  | { status: 'ok'; clientId: string; clientSecret: string }
  | { status: 'not_found' }
  | { status: 'not_sandbox'; clientId: string }
  | { status: 'not_stored'; clientId: string };

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
  async findByClientId(clientId: string): Promise<OAuthAppRow | null> {
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
  ): Promise<OAuthAppRow> {
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
    webhookUrl?: string | null;
    isSandbox?: boolean;
    createdBy?: string;
  }): Promise<{ app: OAuthAppRow; secret: MintedSecret }> {
    const redirectUris = normaliseRedirectUris(params.redirectUris);
    const allowedScopes = normaliseScopes(params.allowedScopes);

    const clientId = generateClientId();
    const clientSecret = generateClientSecret();

    // Hoisted so the flag and the plaintext cannot disagree: one expression
    // governs both columns below, and there is no arrangement of inputs that
    // stores a readable secret on a non-sandbox row.
    const isSandbox = params.isSandbox === true;

    const webhookUrl = normaliseWebhookUrl(params.webhookUrl, isSandbox);
    assertWebhookForIdentityCheck(allowedScopes, webhookUrl);

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
        webhook_url: webhookUrl,
        // `=== true` rather than `?? false`: a truthy non-boolean must not
        // register a sandbox app, and this is the only place the flag is ever
        // written.
        is_sandbox: isSandbox,
        // Readable only for a sandbox app; explicitly null otherwise.
        sandbox_client_secret_plaintext: isSandbox ? clientSecret : null,
        created_by: params.createdBy ?? null,
      },
    });

    return { app, secret: { clientId, clientSecret } };
  }

  /**
   * Edits a registration.
   *
   * `is_sandbox` is intentionally not among the fields: it is set once at
   * creation and never afterwards. See the note on the column in schema.prisma.
   */
  async update(
    id: string,
    params: {
      name?: string;
      description?: string;
      contactEmail?: string;
      logoUrl?: string | null;
      redirectUris?: string[];
      allowedScopes?: string[];
      webhookUrl?: string | null;
      status?: OAuthAppStatus;
    },
  ): Promise<OAuthAppRow> {
    const data: Prisma.OAuthAppUpdateInput = await this.scopeAndWebhookChanges(
      id,
      params,
    );

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
    if (params.status !== undefined) data.status = params.status;

    return this.prisma.oAuthApp.update({ where: { id }, data });
  }

  /**
   * The scope and the URL are checked TOGETHER, against the row as it will be
   * after the update: turning the switch on without a URL, or clearing the URL
   * while the switch stays on, are the same mistake.
   */
  private async scopeAndWebhookChanges(
    id: string,
    params: { allowedScopes?: string[]; webhookUrl?: string | null },
  ): Promise<Prisma.OAuthAppUpdateInput> {
    if (params.allowedScopes === undefined && params.webhookUrl === undefined) {
      return {};
    }

    const current = await this.prisma.oAuthApp.findUniqueOrThrow({
      where: { id },
      select: { allowed_scopes: true, webhook_url: true, is_sandbox: true },
    });

    const scopes =
      params.allowedScopes === undefined
        ? current.allowed_scopes
        : normaliseScopes(params.allowedScopes);
    const webhookUrl =
      params.webhookUrl === undefined
        ? current.webhook_url
        : normaliseWebhookUrl(params.webhookUrl, current.is_sandbox);

    assertWebhookForIdentityCheck(scopes, webhookUrl);

    const data: Prisma.OAuthAppUpdateInput = {};
    if (params.allowedScopes !== undefined) data.allowed_scopes = scopes;
    if (params.webhookUrl !== undefined) data.webhook_url = webhookUrl;
    return data;
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
        // The `: null` branch is not dead code — it is the self-healing path.
        // Any row that somehow acquired a plaintext without being a sandbox app
        // (a bad backfill, a manual UPDATE, a future bug) loses it on the next
        // rotation. Writing this as `...(app.is_sandbox && { … })` reads like a
        // tidy-up and would silently remove that property.
        sandbox_client_secret_plaintext: app.is_sandbox ? clientSecret : null,
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
   * A sandbox app's client secret, in the clear.
   *
   * THE GATE LIVES HERE, not in the controller. This service is already the
   * only place `is_sandbox` and the plaintext are written, so keeping the rule
   * beside the field it protects means a second caller — a support script, the
   * `GET /:id` somebody will eventually add — cannot get an ungated path by
   * default.
   *
   * `is_sandbox === true` rather than a truthy check, mirroring `create`.
   *
   * This is the ONE query in the codebase that asks for the omitted column by
   * name. `grep -rn sandbox_client_secret_plaintext src` should stay a short,
   * auditable list.
   */
  async readSandboxSecret(id: string): Promise<SandboxSecretResult> {
    const app = await this.prisma.oAuthApp.findFirst({
      where: { id, deleted_at: null },
      omit: { sandbox_client_secret_plaintext: false },
    });

    if (!app) return { status: 'not_found' };
    if (app.is_sandbox !== true) {
      return { status: 'not_sandbox', clientId: app.client_id };
    }
    if (!app.sandbox_client_secret_plaintext) {
      // Registered before the column existed. The secret is genuinely gone —
      // one rotation mints a new one and stores it.
      return { status: 'not_stored', clientId: app.client_id };
    }

    return {
      status: 'ok',
      clientId: app.client_id,
      clientSecret: app.sandbox_client_secret_plaintext,
    };
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
  grantableScopes(app: OAuthAppRow, requested: readonly string[]): string[] {
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

  const supported = new Set<string>(REGISTRABLE_SCOPES);
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
  const result = new Set<RegistrableScope>(scopes as RegistrableScope[]);
  result.add('openid');
  return [...result];
}

/** Trimmed, with an empty string meaning "no webhook". */
function normaliseWebhookUrl(
  raw: string | null | undefined,
  isSandbox: boolean,
): string | null {
  const url = raw?.trim();
  if (!url) return null;

  const problem = validateWebhookUrl(url, isSandbox);
  if (problem) {
    throw new OAuthError('invalid_request', `Webhook : ${problem}`, 400);
  }
  return url;
}

/**
 * Identity checks finish asynchronously — the person has to approve on their
 * phone — so an app with the switch on and nowhere to deliver the result would
 * accept checks it can never report.
 */
function assertWebhookForIdentityCheck(
  scopes: readonly string[],
  webhookUrl: string | null,
): void {
  if (scopes.includes(IDENTITY_CHECK_SCOPE) && !webhookUrl) {
    throw new OAuthError(
      'invalid_request',
      "Une URL de webhook est obligatoire pour activer la vérification d'identité.",
      400,
    );
  }
}
