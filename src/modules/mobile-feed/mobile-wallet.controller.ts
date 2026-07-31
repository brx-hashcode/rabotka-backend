import {
  Body,
  Controller,
  Get,
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
import { IsInt, Max, Min } from 'class-validator';
import { PaymentRequestType } from '@prisma/client';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { WalletService } from '../wallet/wallet.service';
import { PaymentRequestService } from '../payment-request/payment-request.service';

// Matches the WhatsApp credit-wallet flow bounds (credit-wallet.flow.ts).
const MIN_TOP_UP = 500;
const MAX_TOP_UP = 500_000;

export class WalletTopUpDto {
  @IsInt()
  @Min(MIN_TOP_UP)
  @Max(MAX_TOP_UP)
  amount!: number;
}

/**
 * Mobile wallet: read the balance and start a mobile-money top-up. Mirrors the
 * WhatsApp credit-wallet flow — a top-up creates a WALLET_TOP_UP payment request
 * and returns its token, which drives the shared /pay/:token screen. Available to
 * any authenticated profile (workers and employers both have wallets).
 */
@ApiTags('Mobile — Wallet')
@ApiBearerAuth()
@Controller('profile/wallet')
@UseGuards(ProfileAuthGuard)
export class MobileWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly paymentRequest: PaymentRequestService,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: '[Mobile] Current wallet balance (FCFA)' })
  @ApiResponse({ status: 200, description: 'Wallet balance' })
  async balance(@Req() req: ProfileAuthenticatedRequest) {
    const balance = await this.wallet.getProfileWalletBalance(
      req.user.profileId,
    );
    return { balance };
  }

  @Post('top-up')
  @ApiOperation({
    summary: '[Mobile] Start a mobile-money wallet top-up',
    description:
      'Creates a WALLET_TOP_UP payment request and returns its token for the /pay/:token screen.',
  })
  @ApiResponse({ status: 200, description: 'Payment token' })
  @ApiResponse({ status: 400, description: 'Amount out of range' })
  async topUp(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: WalletTopUpDto,
  ) {
    const description = `Recharge du portefeuille — ${dto.amount.toLocaleString(
      'fr-FR',
    )} FCFA`;
    const url = await this.paymentRequest.createPaymentUrl(
      req.user.profileId,
      dto.amount,
      description,
      PaymentRequestType.WALLET_TOP_UP,
    );
    const token = url.split('/pay/')[1] ?? '';
    return { token };
  }
}
