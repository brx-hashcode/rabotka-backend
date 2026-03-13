import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('webhooks/payment')
export class PaymentWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('activation/:profileId')
  @HttpCode(HttpStatus.OK)
  async activationSuccess(@Param('profileId') profileId: string): Promise<{ ok: boolean }> {
    await this.paymentService.handleActivationPaymentSuccess(profileId);
    return { ok: true };
  }

  @Post('job-posting/:jobOfferId')
  @HttpCode(HttpStatus.OK)
  async jobPostingSuccess(@Param('jobOfferId') jobOfferId: string): Promise<{ ok: boolean }> {
    await this.paymentService.handleJobPostingPaymentSuccess(jobOfferId);
    return { ok: true };
  }

  @Post('penalties/:profileId')
  @HttpCode(HttpStatus.OK)
  async penaltySuccess(@Param('profileId') profileId: string): Promise<{ ok: boolean }> {
    await this.paymentService.handlePenaltyPaymentSuccess(profileId);
    return { ok: true };
  }
}
