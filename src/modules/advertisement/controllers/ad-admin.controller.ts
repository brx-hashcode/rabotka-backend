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
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdvertisementService } from '../services/advertisement.service';
import { AdAdminService } from '../services/ad-admin.service';
import { AdAnalyticsService } from '../services/ad-analytics.service';
import { CreateAdvertisementDto } from '../dto/create-advertisement.dto';
import { UpdateAdvertisementDto } from '../dto/update-advertisement.dto';
import { ListAdvertisementsDto } from '../dto/list-advertisements.dto';
import { RejectAdvertisementDto } from '../dto/reject-advertisement.dto';
import { CreateBundleDto } from '../dto/create-bundle.dto';
import { UpdateBundleDto } from '../dto/update-bundle.dto';

@Controller('admin/advertisements')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdAdminController {
  constructor(
    private readonly advertisementService: AdvertisementService,
    private readonly adAdminService: AdAdminService,
    private readonly adAnalyticsService: AdAnalyticsService,
  ) {}

  // ─── Advertisements ──────────────────────────────────────────────────────

  @Get()
  @Roles(UserRole.MODERATOR)
  findAll(@Query() filters: ListAdvertisementsDto) {
    return this.advertisementService.findAll(filters);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  create(@Body() dto: CreateAdvertisementDto) {
    return this.advertisementService.create(dto);
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
  createBundle(@Body() dto: CreateBundleDto) {
    return this.adAdminService.createBundle(dto);
  }

  @Patch('bundles/:id')
  @Roles(UserRole.MANAGER)
  updateBundle(@Param('id') id: string, @Body() dto: UpdateBundleDto) {
    return this.adAdminService.updateBundle(id, dto);
  }

  @Delete('bundles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.MANAGER)
  deleteBundle(@Param('id') id: string) {
    return this.adAdminService.deleteBundle(id);
  }

  // ─── Advertisement by ID (wildcard — must come after all static routes) ──

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  findOne(@Param('id') id: string) {
    return this.advertisementService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  update(@Param('id') id: string, @Body() dto: UpdateAdvertisementDto) {
    return this.advertisementService.update(id, dto);
  }

  @Post(':id/confirm-payment')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  confirmPayment(@Param('id') id: string) {
    return this.advertisementService.confirmPayment(id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  submit(@Param('id') id: string) {
    return this.advertisementService.submit(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  approve(@Param('id') id: string) {
    return this.adAdminService.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  reject(@Param('id') id: string, @Body() dto: RejectAdvertisementDto) {
    return this.adAdminService.reject(id, dto.reason);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  pause(@Param('id') id: string) {
    return this.advertisementService.pause(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  resume(@Param('id') id: string) {
    return this.advertisementService.resume(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  cancel(@Param('id') id: string) {
    return this.advertisementService.cancel(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.MANAGER)
  remove(@Param('id') id: string) {
    return this.advertisementService.delete(id);
  }

  @Get(':id/stats')
  @Roles(UserRole.MODERATOR)
  getStats(@Param('id') id: string) {
    return this.adAnalyticsService.getStats(id);
  }

}
