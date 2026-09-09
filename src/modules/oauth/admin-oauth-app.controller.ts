import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OAuthAppStatus, UserRole } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LogService } from '../log/log.service';
import { OAuthAppService } from './services/oauth-app.service';
import { OAuthSandboxService } from './services/oauth-sandbox.service';
import { CreateOAuthAppDto, UpdateOAuthAppDto } from './dto';
import { SUPPORTED_SCOPES } from './oauth.constants';

type AdminRequest = Request & { adminAccount?: { id: string } };

/**
 * Registering partner applications.
 *
 * SUPER_ADMIN only, and deliberately absent from `LATERAL_ACCESS` — see the
 * comment there. Registering an app means deciding who Rabotka will vouch for
 * its users' identities to, which sits with team management rather than with
 * day-to-day operations.
 */
@ApiTags('Admin — Login with Rabotka')
@ApiCookieAuth()
@Controller('admin/oauth-apps')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminOAuthAppController {
  constructor(
    private readonly apps: OAuthAppService,
    private readonly prisma: PrismaService,
    private readonly logs: LogService,
    private readonly sandbox: OAuthSandboxService,
  ) {}

  /** The scope catalogue, so the admin UI never hardcodes its own copy. */
  @Get('scopes')
  scopes() {
    return { scopes: [...SUPPORTED_SCOPES] };
  }

  /**
   * The sandbox catalogue, so the admin UI never hardcodes its own copy — the
   * same reasoning as `scopes` above.
   */
  @Get('sandbox-users')
  sandboxUsers() {
    return this.sandbox.catalogue();
  }

  @Get()
  async list() {
    const apps = await this.prisma.oAuthApp.findMany({
      where: { deleted_at: null },
      orderBy: { created_at: 'desc' },
      // Asked for by name only to derive `canCopySecret` below. The value
      // enters memory and is dropped by the allowlist mapper; the controller
      // spec has a canary asserting it never reaches the response.
      omit: { sandbox_client_secret_plaintext: false },
      include: {
        creator: { select: { first_name: true, last_name: true } },
        // Live consents only. Counting revoked rows too would report people who
        // have since cut the app off as though they were still connected, which
        // is the opposite of what an admin reads this number for. The
        // `[app_id, revoked_at]` index covers the filter.
        _count: {
          select: { authorizations: { where: { revoked_at: null } } },
        },
        // Most recent token exchange across the app's live grants: the answer
        // to "is this integration actually still running", which the count
        // alone cannot give.
        authorizations: {
          where: { revoked_at: null, last_used_at: { not: null } },
          orderBy: { last_used_at: 'desc' },
          take: 1,
          select: { last_used_at: true },
        },
      },
    });

    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      logoUrl: app.logo_url,
      clientId: app.client_id,
      // The hint, never the secret. For a real app nothing can read the secret
      // back — only the hash is stored. A sandbox app is the exception, and
      // even there the secret comes from `GET :id/secret`, never from here.
      clientSecretHint: app.client_secret_hint,
      // Whether a stored plaintext exists, so the UI can render the copy
      // control's disabled state up front instead of only failing on click.
      // Never the secret itself.
      //
      // Not derivable from `isSandbox` alone: a sandbox app registered before
      // the column existed is `isSandbox: true` with nothing to copy, and that
      // is precisely the "rotate once to enable" case.
      canCopySecret:
        app.is_sandbox && app.sandbox_client_secret_plaintext !== null,
      secretRotatedAt: app.secret_rotated_at?.toISOString() ?? null,
      previousSecretExpiresAt:
        app.previous_secret_expires_at?.toISOString() ?? null,
      redirectUris: app.redirect_uris,
      allowedScopes: app.allowed_scopes,
      status: app.status,
      isSandbox: app.is_sandbox,
      contactEmail: app.contact_email,
      createdBy: app.creator
        ? `${app.creator.first_name} ${app.creator.last_name}`
        : null,
      userCount: app._count.authorizations,
      lastUsedAt: app.authorizations[0]?.last_used_at?.toISOString() ?? null,
      createdAt: app.created_at.toISOString(),
    }));
  }

  /**
   * The only response that MINTS a client secret.
   *
   * Shown once, then unrecoverable — with one exception: a sandbox app also
   * stores its secret in the clear, so `GET :id/secret` can return it again.
   * See `sandbox_client_secret_plaintext` in the schema for why that is safe
   * there and nowhere else. The admin UI has to make that obvious,
   * because the alternative — being able to read it back later — means the
   * secret is stored reversibly and one database leak is every partner
   * compromised at once.
   */
  @Post()
  @ApiOperation({
    summary: 'Register an application (returns the secret once)',
  })
  async create(@Body() dto: CreateOAuthAppDto, @Req() req: AdminRequest) {
    const { app, secret } = await this.apps.create({
      ...dto,
      createdBy: req.adminAccount?.id,
    });

    await this.logs.create({
      action: 'OAUTH_APP_CREATED',
      entityType: 'OAuthApp',
      entityId: app.id,
      userId: req.adminAccount?.id,
      metadata: {
        name: app.name,
        clientId: app.client_id,
        redirectUris: app.redirect_uris,
        allowedScopes: app.allowed_scopes,
        isSandbox: app.is_sandbox,
      },
      ...extractRequestMeta(req),
    });

    return {
      id: app.id,
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      isSandbox: app.is_sandbox,
      warning:
        'Copiez cette clé secrète maintenant : elle ne sera plus jamais affichée.',
    };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOAuthAppDto,
    @Req() req: AdminRequest,
  ) {
    const app = await this.apps.update(id, dto);

    await this.logs.create({
      action: 'OAUTH_APP_UPDATED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      metadata: { changes: dto },
      ...extractRequestMeta(req),
    });

    return { id: app.id, status: app.status };
  }

  @Post(':id/rotate-secret')
  async rotateSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    const secret = await this.apps.rotateSecret(id);

    await this.logs.create({
      action: 'OAUTH_APP_SECRET_ROTATED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      ...extractRequestMeta(req),
    });

    return {
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      warning:
        "L'ancienne clé reste valable 24 heures, le temps que le partenaire déploie.",
    };
  }

  /**
   * Reads a SANDBOX app's client secret back, as many times as asked.
   *
   * The one place a stored secret is returned rather than minted. Refused for
   * every real application: those keep the original guarantee, that the secret
   * is shown once and then unrecoverable.
   *
   * The gate itself is in `OAuthAppService.readSandboxSecret` — this method
   * only translates the outcome into HTTP and writes the audit trail. That
   * trail is what makes the readable column defensible: every read, and every
   * refused read, is attributable.
   *
   * Distinct statuses rather than one uniform error, unlike `authenticateClient`
   * — the caller is already SUPER_ADMIN and can read `isSandbox` off the list,
   * so there is nothing to enumerate, and it is what lets the UI say "rotate
   * once" instead of "something went wrong".
   */
  @Get(':id/secret')
  @ApiOperation({
    summary: "Read a sandbox application's client secret (audited)",
  })
  async readSandboxSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    const result = await this.apps.readSandboxSecret(id);

    if (result.status !== 'ok') {
      // A refused read is worth a row of its own: an attempt to read a live
      // partner's secret is exactly the event someone would want to find later.
      await this.logs.create({
        action: 'OAUTH_APP_SECRET_REVEAL_REFUSED',
        entityType: 'OAuthApp',
        entityId: id,
        userId: req.adminAccount?.id,
        metadata: { reason: result.status },
        ...extractRequestMeta(req),
      });

      if (result.status === 'not_found') {
        throw new NotFoundException('Application introuvable.');
      }
      if (result.status === 'not_sandbox') {
        throw new ForbiddenException(
          'Seules les applications sandbox ont une clé secrète récupérable.',
        );
      }
      throw new ConflictException(
        'Cette application sandbox est antérieure à cette fonctionnalité. ' +
          'Effectuez une rotation de la clé une fois pour la rendre copiable.',
      );
    }

    // Awaited, not fire-and-forget: a crash mid-response must still leave the
    // trace. Carries the client id and never the secret — not even the hint,
    // which is worthless to an attacker but also free to leave out.
    await this.logs.create({
      action: 'OAUTH_APP_SANDBOX_SECRET_REVEALED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      metadata: { clientId: result.clientId },
      ...extractRequestMeta(req),
    });

    // No `warning`, unlike create and rotate: for a sandbox app this can be
    // read again, so "it will never be shown again" would be a lie.
    return { clientId: result.clientId, clientSecret: result.clientSecret };
  }

  /** For a secret believed leaked: ends the rotation grace window now. */
  @Post(':id/revoke-previous-secret')
  async revokePreviousSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.apps.revokePreviousSecret(id);

    await this.logs.create({
      action: 'OAUTH_APP_PREVIOUS_SECRET_REVOKED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      ...extractRequestMeta(req),
    });

    return { success: true };
  }

  /**
   * Suspends an app without deleting it.
   *
   * Reversible on purpose: suspension is the response to "something looks
   * wrong", and that is usually resolved by a conversation rather than by a
   * permanent teardown. Takes effect on the next `authorize`, the next `token`
   * and the next `/userinfo` — all three re-read the status.
   */
  @Post(':id/suspend')
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.apps.update(id, { status: OAuthAppStatus.SUSPENDED });

    await this.logs.create({
      action: 'OAUTH_APP_SUSPENDED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      ...extractRequestMeta(req),
    });

    return { success: true };
  }

  @Post(':id/reactivate')
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.apps.update(id, { status: OAuthAppStatus.ACTIVE });

    await this.logs.create({
      action: 'OAUTH_APP_REACTIVATED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      ...extractRequestMeta(req),
    });

    return { success: true };
  }

  /**
   * Soft-deletes the app and revokes every consent behind it in one
   * transaction.
   *
   * The revocation is the point: without it, access tokens already in the
   * partner's hands would keep resolving at `/userinfo` for up to an hour after
   * the app was supposedly removed. `deleted_at` alone would not stop them,
   * because `resolveUserinfo` checks the authorization row.
   */
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.oAuthApp.update({
        where: { id },
        data: {
          deleted_at: now,
          status: OAuthAppStatus.SUSPENDED,
          // A removed app's secret has no legitimate reader, so drop it here
          // rather than leaving it for the next database dump to carry.
          sandbox_client_secret_plaintext: null,
        },
      }),
      this.prisma.oAuthAuthorization.updateMany({
        where: { app_id: id, revoked_at: null },
        data: { revoked_at: now },
      }),
    ]);

    await this.logs.create({
      action: 'OAUTH_APP_DELETED',
      entityType: 'OAuthApp',
      entityId: id,
      userId: req.adminAccount?.id,
      ...extractRequestMeta(req),
    });

    return { success: true };
  }
}
