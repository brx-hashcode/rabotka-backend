import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  WalletOwnerType,
  WalletTransactionType,
  PaymentStatus,
} from '@prisma/client';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import type { PayPenaltyDto } from './dto/pay-penalty.dto';

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the system wallet, creating it if it does not exist.
   */
  async getOrCreateSystemWallet(): Promise<{
    id: string;
    balance: number;
  }> {
    let wallet = await this.prisma.wallet.findFirst({
      where: {
        owner_type: WalletOwnerType.SYSTEM,
        user_id: null,
        profile_id: null,
      },
    });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          owner_type: WalletOwnerType.SYSTEM,
          balance: 0,
        },
      });
    }
    return {
      id: wallet.id,
      balance: Number(wallet.balance),
    };
  }

  /**
   * Records a penalty payment: creates Payment, credits system wallet, and marks penalty as paid.
   * Returns the generated RBK reference. Caller must ensure the penalty exists, belongs to the profile, and is unpaid.
   */
  async recordPenaltyPayment(
    penaltyId: string,
    profileId: string,
    dto: PayPenaltyDto,
  ): Promise<{ reference: string }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (!penalty || penalty.worker_id !== profileId) {
      throw new NotFoundException('Pénalité introuvable');
    }
    if (penalty.paid_at) {
      throw new BadRequestException('Cette pénalité a déjà été réglée');
    }

    const systemWallet = await this.getOrCreateSystemWallet();
    const reference = generatePaymentReference();

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          profile_id: profileId,
          amount: penalty.amount,
          payment_method: dto.paymentMethod,
          transaction_id: reference,
          status: PaymentStatus.COMPLETED,
          completed_at: new Date(),
        },
      });
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CREDIT_PENALTY,
          amount: penalty.amount,
          reference_type: 'penalty',
          reference_id: penaltyId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: {
          balance: { increment: penalty.amount },
        },
      });
      await tx.penalty.update({
        where: { id: penaltyId },
        data: { paid_at: new Date() },
      });
    });

    return { reference };
  }

  /**
   * Returns system revenue (balance of the system wallet) for admin reporting.
   */
  async getSystemRevenue(): Promise<{
    totalRevenue: number;
    balance: number;
  }> {
    const wallet = await this.getOrCreateSystemWallet();
    return {
      totalRevenue: wallet.balance,
      balance: wallet.balance,
    };
  }
}
