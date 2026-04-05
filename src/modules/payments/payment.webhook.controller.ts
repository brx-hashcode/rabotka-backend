import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('webhooks/payment')
export class PaymentWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('penalties/:profileId')
  @HttpCode(HttpStatus.OK)
  async penaltySuccess(@Param('profileId') profileId: string): Promise<{ ok: boolean }> {
    await this.paymentService.handlePenaltyPaymentSuccess(profileId);
    return { ok: true };
  }
}
