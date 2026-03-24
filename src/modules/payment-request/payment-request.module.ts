import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { LogModule } from '../log/log.module';
import { MailModule } from '../mail/mail.module';
import { PaymentsModule } from '../payments/payment.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { PaymentRequestService } from './payment-request.service';
import { PaymentRequestController } from './payment-request.controller';
import { PaymentRequestPublicController } from './payment-request-public.controller';

@Module({
  imports: [PrismaModule, AuthModule, WhatsAppModule, LogModule, MailModule, PaymentsModule, SystemConfigModule],
  controllers: [PaymentRequestController, PaymentRequestPublicController],
  providers: [PaymentRequestService],
  exports: [PaymentRequestService],
})
export class PaymentRequestModule {}
