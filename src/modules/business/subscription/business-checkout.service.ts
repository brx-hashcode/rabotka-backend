import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessBillingPeriod,
  BusinessCreditKind,
  PaymentRequestType,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { PaymentRequestService } from '../../payment-request/payment-request.service';
import { appUrlFor } from '../../mail/audience';
import {
  BusinessSubscriptionService,
  PERIOD_LABEL,
} from './business-subscription.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { creditLabel, PACK_SETTING } from './business-credits';
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
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly systemConfig: SystemConfigService,
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
      include: { business: { select: { profile_id: true } } },
    });
    // Another business's custom plan reads as not there at all.
    if (
      !plan ||
      !plan.is_active ||
      plan.deleted_at ||
      (plan.business && plan.business.profile_id !== profileId)
    ) {
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

  /**
   * A BUSINESS_CREDIT_PACK payment request for `count` packs of a kind,
   * priced now from the settings. The credits are added when the payment
   * succeeds (BusinessSubscriptionService.addCreditsFromPayment). Needs a
   * plan running: credits are only spent on top of one.
   */
  async buyPack(
    profileId: string,
    kind: BusinessCreditKind,
    count: number,
  ): Promise<{ token: string; amount: number }> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId || !(await this.subscriptions.current(businessId))) {
      throw new BadRequestException(
        'Choisissez d’abord une formule : les packs s’ajoutent à celle-ci.',
      );
    }
    const packs = await this.systemConfig.getBusinessPackSettings();
    const pack = packs[PACK_SETTING[kind]];
    if (pack.priceFcfa <= 0 || pack.quantity <= 0) {
      throw new NotFoundException('Ce pack n’est pas disponible.');
    }
    const quantity = pack.quantity * count;
    const amount = pack.priceFcfa * count;
    let token = '';
    await this.paymentRequests.createPaymentUrl(
      profileId,
      amount,
      `Pack Rabotka Business — ${creditLabel(kind, quantity)}`,
      PaymentRequestType.BUSINESS_CREDIT_PACK,
      {
        creditPack: { kind, quantity },
        urlFor: (t) => {
          token = t;
          return `${appUrlFor('business')}/payer/${t}`;
        },
      },
    );
    return { token, amount };
  }
}
