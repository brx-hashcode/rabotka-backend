import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
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
import { ProfileType, PaymentRequestType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ApplicationService } from '../application/application.service';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentRequestService } from '../payment-request/payment-request.service';

export class RejectApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CompleteMissionDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Mobile-facing (EMPLOYER) application actions: accept / reject a candidate, then
 * pay the contact-unlock fee (wallet or mobile money) and read the revealed
 * contact. Thin ProfileAuthGuard wrappers over the same services the WhatsApp bot
 * uses. State machine: PENDING/VIEWED --accept--> WAITING_PAYMENT --pay--> ACCEPTED.
 */
@ApiTags('Mobile — Applications')
@ApiBearerAuth()
@Controller('profile/applications')
@UseGuards(ProfileAuthGuard)
export class MobileApplicationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationService: ApplicationService,
    private readonly contactUnlock: ContactUnlockService,
    private readonly systemConfig: SystemConfigService,
    private readonly wallet: WalletService,
    private readonly paymentRequest: PaymentRequestService,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Application detail (+ unlock state + contact)',
  })
  @ApiResponse({ status: 200, description: 'Composite application detail' })
  @ApiResponse({ status: 403, description: 'Not the owner employer' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getDetail(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.assertEmployer(req.user.profileId);
    return this.buildDetail(id, req.user.profileId);
  }

  @Post(':id/accept')
  @UseGuards(KycVerifiedGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Accept a candidate (→ WAITING_PAYMENT)',
  })
  async accept(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    await this.applicationService.accept(id, profileId);
    return this.buildDetail(id, profileId);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: '[Mobile/EMPLOYER] Reject a candidate (→ REJECTED)' })
  async reject(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: RejectApplicationDto,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    const application = await this.applicationService.reject(
      id,
      profileId,
      body.reason,
    );
    return { application };
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Mark the mission completed and rate the worker',
    description:
      'Closes the offer, pays the worker, stores the optional note on the assignment, and records the employer→worker rating (1–5).',
  })
  @ApiResponse({ status: 200, description: 'Mission completed and rated' })
  @ApiResponse({ status: 400, description: 'Invalid state or score' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER / not the owner' })
  async complete(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CompleteMissionDto,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    await this.applicationService.completeAndRate(
      id,
      profileId,
      body.score,
      body.note,
    );
    return { success: true };
  }

  @Post(':id/unlock/pay-wallet')
  @UseGuards(KycVerifiedGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Pay the contact-unlock fee with wallet credit',
  })
  async payWallet(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    const attempt = await this.getOwnedAttempt(id, profileId);
    await this.contactUnlock.payUnlock(attempt.id, profileId, true);
    return this.buildDetail(id, profileId);
  }

  @Post(':id/unlock/pay-mobile')
  @UseGuards(KycVerifiedGuard)
  @ApiOperation({
    summary:
      '[Mobile/EMPLOYER] Create a mobile-money payment for the contact unlock',
  })
  @ApiResponse({ status: 200, description: 'Payment token to drive /pay/:token' })
  async payMobile(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    const attempt = await this.getOwnedAttempt(id, profileId);
    const url = await this.paymentRequest.createPaymentUrl(
      profileId,
      Number(attempt.employer_amount),
      'Déverrouillage du contact',
      PaymentRequestType.CONTACT_UNLOCK,
      { contactUnlockAttemptId: attempt.id },
    );
    const token = url.split('/pay/')[1] ?? '';
    return { token };
  }

  // --- helpers ---

  private async buildDetail(id: string, profileId: string) {
    const application = await this.applicationService.findById(id);
    if (!application) {
      throw new NotFoundException('Candidature introuvable');
    }
    if (application.job_offer.employer_id !== profileId) {
      throw new ForbiddenException("Vous n'êtes pas l'employeur de cette offre");
    }

    // Public portfolio slug so the employer can open the candidate's profile.
    const workerProfile = await this.prisma.profile.findUnique({
      where: { id: application.worker_id },
      select: { portfolio_slug: true },
    });
    const workerSlug = workerProfile?.portfolio_slug ?? null;

    const attempt = await this.contactUnlock.getByApplicationId(id);
    if (!attempt) {
      return { application, unlock: null, workerSlug };
    }

    const balance = await this.wallet.getProfileWalletBalance(profileId);
    const unlock = {
      attemptId: attempt.id,
      status: attempt.status,
      employerFee: Number(attempt.employer_amount),
      walletBalance: balance,
      expiresAt: attempt.expires_at,
      employerPaid: attempt.employer_paid,
      workerPaid: attempt.worker_paid,
    };

    // Contact details are delivered to both parties over WhatsApp once both
    // have paid — never exposed through this API.
    return { application, unlock, workerSlug };
  }

  private async getOwnedAttempt(id: string, profileId: string) {
    const application = await this.applicationService.findById(id);
    if (!application) {
      throw new NotFoundException('Candidature introuvable');
    }
    if (application.job_offer.employer_id !== profileId) {
      throw new ForbiddenException("Vous n'êtes pas l'employeur de cette offre");
    }
    const attempt = await this.contactUnlock.getByApplicationId(id);
    if (!attempt) {
      throw new BadRequestException(
        "Cette candidature n'a pas de déverrouillage en attente. Acceptez-la d'abord.",
      );
    }
    return attempt;
  }

  private async assertEmployer(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== ProfileType.EMPLOYER) {
      throw new ForbiddenException('Réservé aux employeurs');
    }
  }
}
