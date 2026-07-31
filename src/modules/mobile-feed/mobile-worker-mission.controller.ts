import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaymentRequestType, ProfileType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ApplicationService } from '../application/application.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentRequestService } from '../payment-request/payment-request.service';

export class WorkerCompleteMissionDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;
}

export class WorkerCancelApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Worker-facing (WORKER) view of their own missions (jobs they were hired on),
 * plus the ability to mark their side done and rate the employer (1–5). Thin
 * ProfileAuthGuard wrappers over ApplicationService. Kept on a distinct base path
 * so it never collides with the employer-guarded /profile/applications routes.
 */
@ApiTags('Mobile — Worker missions')
@ApiBearerAuth()
@Controller('profile/worker/missions')
@UseGuards(ProfileAuthGuard)
export class MobileWorkerMissionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationService: ApplicationService,
    private readonly systemConfig: SystemConfigService,
    private readonly contactUnlock: ContactUnlockService,
    private readonly wallet: WalletService,
    private readonly paymentRequest: PaymentRequestService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '[Mobile/WORKER] My missions (jobs I was hired on)',
  })
  @ApiResponse({ status: 200, description: 'Paginated worker missions' })
  @ApiResponse({ status: 403, description: 'Not a WORKER profile' })
  async list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    return this.applicationService.findWorkerMissions(profileId, {
      page: this.parseInt(page, 0, 10_000),
      pageSize: this.parseInt(pageSize, 20, 100),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '[Mobile/WORKER] One of my missions' })
  @ApiResponse({ status: 200, description: 'Mission detail' })
  @ApiResponse({ status: 403, description: 'Not a WORKER profile' })
  @ApiResponse({ status: 404, description: 'Mission not found' })
  async detail(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    return this.applicationService.findWorkerMissionById(profileId, id);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: '[Mobile/WORKER] Mark my side done and rate the employer',
    description:
      'Marks this worker’s own assignment completed and records the worker→employer rating (1–5). Does not close the offer or trigger payment.',
  })
  @ApiResponse({ status: 200, description: 'Completed and rated' })
  @ApiResponse({ status: 400, description: 'Invalid state or score' })
  @ApiResponse({ status: 403, description: 'Not a WORKER / not the owner' })
  async complete(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: WorkerCompleteMissionDto,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    await this.applicationService.completeAndRateByWorker(
      id,
      profileId,
      body.score,
    );
    return { success: true };
  }

  @Get(':id/unlock')
  @ApiOperation({
    summary: "[Mobile/WORKER] My side of the contact unlock",
    description:
      'Contacts are released to both parties on WhatsApp only once BOTH have paid their share. The employer had web endpoints for this from the start; the worker did not, so an accepted worker could be stuck at "Paiement requis" with no way to pay.',
  })
  @ApiResponse({ status: 200, description: 'Unlock state, or null if none' })
  async unlockState(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const attempt = await this.getOwnedAttempt(id, profileId);
    if (!attempt) return { unlock: null };

    const balance = await this.wallet.getProfileWalletBalance(profileId);
    return {
      unlock: {
        attemptId: attempt.id,
        status: attempt.status,
        workerFee: Number(attempt.worker_amount),
        walletBalance: balance,
        expiresAt: attempt.expires_at,
        employerPaid: attempt.employer_paid,
        workerPaid: attempt.worker_paid,
      },
    };
    // Contact details themselves are never returned here — they are delivered
    // over WhatsApp once both sides have paid.
  }

  @Post(':id/unlock/pay-wallet')
  @UseGuards(KycVerifiedGuard)
  @ApiOperation({
    summary: "[Mobile/WORKER] Pay my share of the contact unlock from wallet",
  })
  @ApiResponse({ status: 200, description: 'Updated unlock state' })
  @ApiResponse({ status: 400, description: 'No pending unlock / already paid' })
  async payUnlockWallet(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const attempt = await this.requireOwnedAttempt(id, profileId);
    // payUnlock is party-aware: it resolves employer vs worker from profileId
    // and charges the matching amount, so no worker-specific branch is needed.
    await this.contactUnlock.payUnlock(attempt.id, profileId, true);
    return this.unlockState(req, id);
  }

  @Post(':id/unlock/pay-mobile')
  @UseGuards(KycVerifiedGuard)
  @ApiOperation({
    summary:
      '[Mobile/WORKER] Create a mobile-money payment for my share of the unlock',
  })
  @ApiResponse({ status: 200, description: 'Payment token to drive /pay/:token' })
  async payUnlockMobile(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const attempt = await this.requireOwnedAttempt(id, profileId);
    const url = await this.paymentRequest.createPaymentUrl(
      profileId,
      Number(attempt.worker_amount),
      'Déverrouillage du contact',
      PaymentRequestType.CONTACT_UNLOCK,
      { contactUnlockAttemptId: attempt.id },
    );
    const token = url.split('/pay/')[1] ?? '';
    return { token };
  }

  @Get(':id/cancellation-preview')
  @ApiOperation({
    summary: '[Mobile/WORKER] Would cancelling this now incur a penalty?',
    description:
      'Lets the UI warn before the worker commits. Cancelling within the configured threshold of the start time costs a penalty and a reliability-score deduction, so this must be shown up front — the WhatsApp flow has always warned first.',
  })
  @ApiResponse({ status: 200, description: 'Penalty preview' })
  async cancellationPreview(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const [wouldPenalize, fees] = await Promise.all([
      this.applicationService.wouldPenalizeCancellation(id, profileId),
      this.systemConfig.getFees(),
    ]);
    return {
      wouldPenalize,
      penaltyFcfa: fees.lateCancellationPenaltyFcfa,
      thresholdHours: fees.cancellationThresholdHours,
      scoreDeduction: fees.lateCancellationScoreDeduction,
    };
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: '[Mobile/WORKER] Cancel my own application or mission',
    description:
      'Previously only possible over WhatsApp, so a worker who applied on the web had no way to withdraw. Cancelling close to the start time applies a penalty and a reliability-score deduction — call the cancellation-preview endpoint first and confirm.',
  })
  @ApiResponse({ status: 200, description: 'Cancelled (with penalty info)' })
  @ApiResponse({ status: 400, description: 'Not in a cancellable state' })
  @ApiResponse({ status: 403, description: 'Not a WORKER / not the owner' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async cancel(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: WorkerCancelApplicationDto,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const result = await this.applicationService.cancel(
      id,
      profileId,
      body.reason,
    );
    return {
      success: true,
      penaltyApplied: result.penaltyApplied,
      penaltyAmount: result.penaltyAmount,
    };
  }

  /**
   * The unlock attempt for one of THIS worker's applications, or null.
   * Ownership is checked on the worker side of the application, mirroring the
   * employer-side `getOwnedAttempt`.
   */
  private async getOwnedAttempt(id: string, profileId: string) {
    const application = await this.applicationService.findById(id);
    if (!application) {
      throw new NotFoundException('Candidature introuvable');
    }
    if (application.worker_id !== profileId) {
      throw new ForbiddenException("Cette candidature n'est pas la vôtre");
    }
    return this.contactUnlock.getByApplicationId(id);
  }

  /** Same, but 400s when there is nothing to pay for. */
  private async requireOwnedAttempt(id: string, profileId: string) {
    const attempt = await this.getOwnedAttempt(id, profileId);
    if (!attempt) {
      throw new BadRequestException(
        "Cette candidature n'a pas de déverrouillage en attente.",
      );
    }
    return attempt;
  }

  private parseInt(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n < 0) return fallback;
    return Math.min(n, max);
  }

  private async assertWorker(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== ProfileType.WORKER) {
      throw new ForbiddenException('Réservé aux travailleurs');
    }
  }
}
