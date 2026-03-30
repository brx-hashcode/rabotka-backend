import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentRequestService } from './payment-request.service';
import { PaymentRequestController } from './payment-request.controller';
import { PaymentRequestPublicController } from './payment-request-public.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PaymentRequestController, PaymentRequestPublicController],
  providers: [PaymentRequestService],
  exports: [PaymentRequestService],
})
export class PaymentRequestModule {}
