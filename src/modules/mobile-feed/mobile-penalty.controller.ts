import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaymentRequestType } from '@prisma/client';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentRequestService } from '../payment-request/payment-request.service';

/**
 * Settling unpaid penalties from the app. Offers the same two payment methods as
 * the rest of the app (and the WhatsApp pay-penalties flow): the profile's own
 * wallet, or Mobile Money via the shared /pay/:token screen.
 */
@ApiTags('Mobile — Penalties')
@ApiBearerAuth()
@Controller('profile/penalties')
@UseGuards(ProfileAuthGuard)
export class MobilePenaltyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly paymentRequest: PaymentRequestService,
  ) {}

  @Get('due')
  @ApiOperation({
    summary: '[Mobile] Unpaid penalty total + wallet balance',
    description:
      'Everything the payment-method chooser needs: how much is owed, how many penalties, and the current wallet balance.',
  })
  @ApiResponse({ status: 200, description: 'Amount due and wallet balance' })
  async due(@Req() req: ProfileAuthenticatedRequest) {
    const profileId = req.user.profileId;
    const [unpaid, walletBalance] = await Promise.all([
      this.prisma.penalty.findMany({
        where: { profile_id: profileId, paid_at: null },
        select: { amount: true },
      }),
      this.wallet.getProfileWalletBalance(profileId),
    ]);
    return {
      count: unpaid.length,
      totalAmount: unpaid.reduce((sum, p) => sum + Number(p.amount), 0),
      walletBalance,
    };
  }

  @Post('pay/wallet')
  @ApiOperation({
    summary: '[Mobile] Pay all unpaid penalties from the profile wallet',
    description:
      'Debits the total from the profile wallet, credits the system wallet, marks the penalties paid and recomputes billing status. 400 if the balance is short.',
  })
  @ApiResponse({ status: 200, description: 'Penalties paid' })
  @ApiResponse({
    status: 400,
    description: 'No unpaid penalties or insufficient balance',
  })
  async payWithWallet(@Req() req: ProfileAuthenticatedRequest) {
    return this.wallet.payAllPenaltiesWithWallet(req.user.profileId);
  }

  @Post('pay/link')
  @ApiOperation({
    summary: '[Mobile] Start a payment for all unpaid penalties',
    description:
      'Creates a PENALTY_RESOLUTION payment request for the total unpaid amount and returns its token for the /pay/:token screen.',
  })
  @ApiResponse({ status: 200, description: 'Payment token' })
  @ApiResponse({ status: 400, description: 'No unpaid penalties' })
  async payWithLink(@Req() req: ProfileAuthenticatedRequest) {
    const profileId = req.user.profileId;
    const unpaid = await this.prisma.penalty.findMany({
      where: { profile_id: profileId, paid_at: null },
      select: { amount: true },
    });
    if (unpaid.length === 0) {
      throw new BadRequestException('Aucune pénalité impayée');
    }
    const totalAmount = unpaid.reduce((sum, p) => sum + Number(p.amount), 0);
    const url = await this.paymentRequest.createPaymentUrl(
      profileId,
      totalAmount,
      `Règlement de pénalités (${unpaid.length} pénalité(s))`,
      PaymentRequestType.PENALTY_RESOLUTION,
    );
    const token = url.split('/pay/')[1] ?? '';
    return { token };
  }
}
