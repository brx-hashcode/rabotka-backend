import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { BotModule } from '../bot/bot.module';
import { PaymentService } from './payment.service';
import { PaymentWebhookController } from './payment.webhook.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => BotModule)],
  controllers: [PaymentWebhookController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentsModule {}
