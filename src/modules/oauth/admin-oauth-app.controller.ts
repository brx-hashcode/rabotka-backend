import {
  Body,
  Controller,
  Delete,
  Get,
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
  ) {}

  /** The scope catalogue, so the admin UI never hardcodes its own copy. */
  @Get('scopes')
  scopes() {
    return { scopes: [...SUPPORTED_SCOPES] };
  }

  @Get()
  async list() {
    const apps = await this.prisma.oAuthApp.findMany({
      where: { deleted_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        creator: { select: { first_name: true, last_name: true } },
        _count: { select: { authorizations: true } },
      },
    });

    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      logoUrl: app.logo_url,
      clientId: app.client_id,
      // The hint, never the secret. There is no code path that can read a
      // secret back — only the hash is stored.
      clientSecretHint: app.client_secret_hint,
      secretRotatedAt: app.secret_rotated_at?.toISOString() ?? null,
      previousSecretExpiresAt:
        app.previous_secret_expires_at?.toISOString() ?? null,
      redirectUris: app.redirect_uris,
      allowedScopes: app.allowed_scopes,
      status: app.status,
      contactEmail: app.contact_email,
      createdBy: app.creator
        ? `${app.creator.first_name} ${app.creator.last_name}`
        : null,
      userCount: app._count.authorizations,
      createdAt: app.created_at.toISOString(),
    }));
  }

  /**
   * The only response that ever contains a client secret.
   *
   * Shown once, then unrecoverable. The admin UI has to make that obvious,
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
      },
      ...extractRequestMeta(req),
    });

    return {
      id: app.id,
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
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
        data: { deleted_at: now, status: OAuthAppStatus.SUSPENDED },
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
