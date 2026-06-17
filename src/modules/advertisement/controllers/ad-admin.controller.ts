import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { AdminAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { AdvertisementService } from '../services/advertisement.service';
import { AdAdminService } from '../services/ad-admin.service';
import { AdAnalyticsService } from '../services/ad-analytics.service';
import { CreateAdvertisementDto } from '../dto/create-advertisement.dto';
import { UpdateAdvertisementDto } from '../dto/update-advertisement.dto';
import { ListAdvertisementsDto } from '../dto/list-advertisements.dto';
import { RejectAdvertisementDto } from '../dto/reject-advertisement.dto';
import { CreateBundleDto } from '../dto/create-bundle.dto';
import { UpdateBundleDto } from '../dto/update-bundle.dto';
import { LogService } from '../../log/log.service';
import { extractRequestMeta } from '../../../common/utils/request-meta.util';

@Controller('admin/advertisements')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdAdminController {
  constructor(
    private readonly advertisementService: AdvertisementService,
    private readonly adAdminService: AdAdminService,
    private readonly adAnalyticsService: AdAnalyticsService,
    private readonly logService: LogService,
  ) {}

  // ─── Advertisements ──────────────────────────────────────────────────────

  @Get()
  @Roles(UserRole.MODERATOR)
  findAll(@Query() filters: ListAdvertisementsDto) {
    return this.advertisementService.findAll(filters);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateAdvertisementDto,
  ) {
    const ad = await this.advertisementService.create(dto);
    await this.logService.create({
      action: 'AD_CREATED',
      entityType: 'advertisement',
      entityId: (ad as { id?: string })?.id,
      userId: req.user?.userId,
      metadata: { ...dto },
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Get('pending')
  @Roles(UserRole.MODERATOR)
  listPending() {
    return this.adAdminService.listPendingReview();
  }

  @Get('dashboard')
  @Roles(UserRole.MODERATOR)
  getDashboard() {
    return this.adAnalyticsService.getDashboard();
  }

  // ─── Bundles (must be before :id wildcard) ───────────────────────────────

  @Get('bundles')
  @Roles(UserRole.MODERATOR)
  listBundles() {
    return this.adAdminService.listBundles();
  }

  @Post('bundles')
  @Roles(UserRole.MANAGER)
  async createBundle(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateBundleDto,
  ) {
    const bundle = await this.adAdminService.createBundle(dto);
    await this.logService.create({
      action: 'AD_BUNDLE_CREATED',
      entityType: 'ad_bundle',
      entityId: (bundle as { id?: string })?.id,
      userId: req.user?.userId,
      metadata: { ...dto },
      ...extractRequestMeta(req),
    });
    return bundle;
  }

  @Patch('bundles/:id')
  @Roles(UserRole.MANAGER)
  async updateBundle(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateBundleDto,
  ) {
    const bundle = await this.adAdminService.updateBundle(id, dto);
    await this.logService.create({
      action: 'AD_BUNDLE_UPDATED',
      entityType: 'ad_bundle',
      entityId: id,
      userId: req.user?.userId,
      metadata: { changes: { ...dto } },
      ...extractRequestMeta(req),
    });
    return bundle;
  }

  @Delete('bundles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.MANAGER)
  async deleteBundle(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const result = await this.adAdminService.deleteBundle(id);
    await this.logService.create({
      action: 'AD_BUNDLE_DELETED',
      entityType: 'ad_bundle',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }

  // ─── Advertisement by ID (wildcard — must come after all static routes) ──

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  findOne(@Param('id') id: string) {
    return this.advertisementService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAdvertisementDto,
  ) {
    const ad = await this.advertisementService.update(id, dto);
    await this.logService.create({
      action: 'AD_UPDATED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      metadata: { changes: { ...dto } },
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/confirm-payment')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async confirmPayment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const ad = await this.advertisementService.confirmPayment(id);
    await this.logService.create({
      action: 'AD_PAYMENT_CONFIRMED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async submit(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const ad = await this.advertisementService.submit(id);
    await this.logService.create({
      action: 'AD_SUBMITTED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const ad = await this.adAdminService.approve(id);
    await this.logService.create({
      action: 'AD_APPROVED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectAdvertisementDto,
  ) {
    const ad = await this.adAdminService.reject(id, dto.reason);
    await this.logService.create({
      action: 'AD_REJECTED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      metadata: { reason: dto.reason },
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async pause(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const ad = await this.advertisementService.pause(id);
    await this.logService.create({
      action: 'AD_PAUSED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async resume(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const ad = await this.advertisementService.resume(id);
    await this.logService.create({
      action: 'AD_RESUMED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  async cancel(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const ad = await this.advertisementService.cancel(id);
    await this.logService.create({
      action: 'AD_CANCELLED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return ad;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.MANAGER)
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    const result = await this.advertisementService.delete(id);
    await this.logService.create({
      action: 'AD_DELETED',
      entityType: 'advertisement',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get(':id/stats')
  @Roles(UserRole.MODERATOR)
  getStats(@Param('id') id: string) {
    return this.adAnalyticsService.getStats(id);
  }

  @Get(':id/analytics')
  @Roles(UserRole.MODERATOR)
  getAnalytics(@Param('id') id: string) {
    return this.adAnalyticsService.getAnalytics(id);
  }
}
