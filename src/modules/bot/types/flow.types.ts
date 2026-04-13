import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { ApplicationService } from '../../application/application.service';
import type { PaymentService } from '../../payments/payment.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { BotCommandsService } from '../services/bot-commands.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { BotState } from './bot-state.types';

/**
 * Unified context passed to all bot flows.
 * Each flow picks only the services it needs via its own narrower type alias.
 */
export type FlowContext = {
  prisma: PrismaService;
  jobOfferService: JobOfferService;
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  systemConfigService: SystemConfigService;
  paymentService: PaymentService;
  commands: BotCommandsService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
  clearDraft?: boolean;
};
