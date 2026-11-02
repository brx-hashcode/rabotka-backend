import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';
import { BusinessSubscriptionService } from './business-subscription.service';
import {
  AdminCancelSubscriptionDto,
  AdminGrantDto,
  CreateBusinessPlanDto,
  UpdateBusinessPlanDto,
} from './dto/business-plan.dto';
import { planData, planView } from './plan-view';

/**
 * Business plans (the catalog: prices, quotas, features) and each business's
 * subscription, for the admin. A deleted plan stays in the database, hidden,
 * since past periods and payments point to it.
 */
@ApiTags('Admin – Business subscriptions')
@Controller('admin')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminBusinessSubscriptionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly logService: LogService,
  ) {}

  @Get('business-plans')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'All business plans, active or not' })
  async listPlans() {
    const [plans, businesses] = await Promise.all([
      this.subscriptions.listPlans(false),
      this.subscriptions.businessesPerPlan(),
    ]);
    // How many businesses a deletion would cancel.
    return plans.map((p) => ({
      ...planView(p),
      businesses: businesses.get(p.id) ?? 0,
    }));
  }

  @Post('business-plans')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Create a business plan' })
  async createPlan(
    @Body() dto: CreateBusinessPlanDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    try {
      const plan = await this.prisma.businessPlan.create({
        data: planData(dto) as Prisma.BusinessPlanCreateInput,
      });
      await this.log(req, 'BUSINESS_PLAN_CREATED', plan.id, {
        code: plan.code,
      });
      return planView(plan);
    } catch (err) {
      throw this.duplicate(err);
    }
  }

  @Patch('business-plans/:planId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Edit a business plan (new prices apply to new purchases)',
  })
  async updatePlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateBusinessPlanDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    try {
      const plan = await this.prisma.businessPlan.update({
        where: { id: planId, deleted_at: null },
        data: planData(dto),
      });
      await this.log(req, 'BUSINESS_PLAN_UPDATED', plan.id, {
        fields: Object.keys(dto),
      });
      return planView(plan);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Formule introuvable.');
      }
      throw this.duplicate(err);
    }
  }

  @Delete('business-plans/:planId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary:
      'Delete a business plan: hidden everywhere, and every business on it is cancelled',
  })
  async deletePlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const { plan, businesses } = await this.subscriptions.deletePlan(
      planId,
      req.user?.userId ?? null,
    );
    await this.log(req, 'BUSINESS_PLAN_DELETED', plan.id, {
      code: plan.code,
      businessesCancelled: businesses,
    });
    return { businessesCancelled: businesses };
  }

  @Get('profiles/:id/business/subscription')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "A business's plan, usage and periods" })
  async getSubscription(@Param('id', ParseUUIDPipe) profileId: string) {
    return this.subscriptions.overview(await this.businessId(profileId));
  }

  @Post('profiles/:id/business/subscription')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary:
      'Assign a plan by hand: after the running period, or replacing it now (startNow)',
  })
  async grant(
    @Param('id', ParseUUIDPipe) profileId: string,
    @Body() dto: AdminGrantDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const businessId = await this.businessId(profileId);
    const sub = await this.subscriptions.grantByAdmin(
      businessId,
      dto.planId,
      dto.billingPeriod,
      req.user?.userId ?? null,
      { startNow: dto.startNow ?? false },
    );
    await this.log(
      req,
      'BUSINESS_SUBSCRIPTION_GRANTED',
      sub.id,
      {
        plan: sub.plan.code,
        period: dto.billingPeriod,
        startNow: dto.startNow ?? false,
      },
      profileId,
    );
    return this.subscriptions.overview(businessId);
  }

  @Post('profiles/:id/business/subscription/:subscriptionId/cancel')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary:
      'End a period now (or drop one not yet started), and the periods queued after it; the business is told',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) profileId: string,
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
    @Body() dto: AdminCancelSubscriptionDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const businessId = await this.businessId(profileId);
    const reason = dto.reason ?? null;
    await this.subscriptions.cancelByAdmin(
      businessId,
      subscriptionId,
      req.user?.userId ?? null,
      reason,
    );
    await this.log(
      req,
      'BUSINESS_SUBSCRIPTION_CANCELLED',
      subscriptionId,
      { reason },
      profileId,
    );
    return this.subscriptions.overview(businessId);
  }

  private async businessId(profileId: string): Promise<string> {
    const id = await this.subscriptions.businessOf(profileId);
    if (!id)
      throw new NotFoundException("Ce profil n'est pas un compte entreprise.");
    return id;
  }

  private duplicate(err: unknown): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException('Une formule utilise déjà ce code.');
    }
    return err;
  }

  private log(
    req: AdminAuthenticatedRequest,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
    profileId?: string,
  ) {
    return this.logService.create({
      action,
      entityType: action.startsWith('BUSINESS_PLAN')
        ? 'BusinessPlan'
        : 'BusinessSubscription',
      entityId,
      userId: req.user?.userId ?? 'system',
      ...(profileId && { profileId }),
      metadata,
    });
  }
}
