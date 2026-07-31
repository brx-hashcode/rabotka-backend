import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { MailModule } from '../mail/mail.module';
import { WsNotificationsModule } from '../ws-notifications/ws-notifications.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';
import { BotModule } from '../bot/bot.module';
import { LogModule } from '../log/log.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { StorageModule } from '../../common/services/storage/storage.module';
import { PaymentGatewayModule } from '../../common/services/payment/payment-gateway.module';
import { PaymentRequestService } from './payment-request.service';
import { PaymentRequestController } from './payment-request.controller';
import { PaymentRequestPublicController } from './payment-request-public.controller';
import { PollPaymentStatusProcessor } from './poll-payment-status.processor';
import { PollPaymentStatusWorkerService } from './poll-payment-status.worker.service';

@Module({
  imports: [
    AdminArchiveModule,
    PrismaModule,
    AuthModule,
    ConfigModule,
    SystemConfigModule,
    WalletModule,
    WhatsAppModule,
    MailModule,
    WsNotificationsModule,
    forwardRef(() => ContactUnlockModule),
    forwardRef(() => BotModule),
    LogModule,
    InvoiceModule,
    StorageModule,
    PaymentGatewayModule,
  ],
  controllers: [PaymentRequestController, PaymentRequestPublicController],
  providers: [
    PaymentRequestService,
    PollPaymentStatusProcessor,
    PollPaymentStatusWorkerService,
  ],
  exports: [PaymentRequestService, PollPaymentStatusProcessor],
})
export class PaymentRequestModule {}
