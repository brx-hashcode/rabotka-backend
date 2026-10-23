import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusinessBillingPeriod, PaymentRequestType } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { PaymentRequestService } from '../../payment-request/payment-request.service';
import { appUrlFor } from '../../mail/audience';
import { PERIOD_LABEL } from './business-subscription.service';
import { priceFor } from './subscription-rules';

/**
 * Buying a plan. Apart from BusinessSubscriptionService so that service stays
 * free of the payments module, which itself depends on contact unlocks — the
 * flows that consult the subscription's quotas.
 */
@Injectable()
export class BusinessCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRequests: PaymentRequestService,
  ) {}

  /**
   * A BUSINESS_SUBSCRIPTION payment request priced now, paid from the
   * dashboard's own pay page. The period is created only when the payment
   * succeeds (BusinessSubscriptionService.activateFromPayment).
   */
  async checkout(
    profileId: string,
    planId: string,
    period: BusinessBillingPeriod,
  ): Promise<{ token: string; amount: number }> {
    if (period === BusinessBillingPeriod.TRIAL) {
      throw new BadRequestException(
        'Choisissez une formule mensuelle ou annuelle.',
      );
    }
    const plan = await this.prisma.businessPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || !plan.is_active) {
      throw new NotFoundException('Cette formule n’est pas disponible.');
    }
    const amount = priceFor(plan, period);
    if (amount <= 0) {
      throw new BadRequestException(
        'Cette formule n’a pas de prix pour cette période.',
      );
    }
    let token = '';
    await this.paymentRequests.createPaymentUrl(
      profileId,
      amount,
      `Abonnement Rabotka Business ${plan.name} — ${PERIOD_LABEL[period]}`,
      PaymentRequestType.BUSINESS_SUBSCRIPTION,
      {
        businessPlan: { planId: plan.id, period },
        urlFor: (t) => {
          token = t;
          return `${appUrlFor('business')}/payer/${t}`;
        },
      },
    );
    return { token, amount };
  }
}
