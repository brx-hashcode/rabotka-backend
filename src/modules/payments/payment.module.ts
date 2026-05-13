import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { BotModule } from '../bot/bot.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { PaymentService } from './payment.service';
import { PaymentProcessor } from './payment.processor';
import { PaymentWebhookController } from './payment.webhook.controller';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => BotModule),
    forwardRef(() => SystemConfigModule),
  ],
  controllers: [PaymentWebhookController],
  providers: [PaymentService, PaymentProcessor],
  exports: [PaymentService, PaymentProcessor],
})
export class PaymentsModule {}
