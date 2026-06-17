import {
  Controller,
  Post,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';

@Controller('webhooks/payment')
export class PaymentWebhookController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly configService: ConfigService,
  ) {}

  @Post('penalties/:profileId')
  @HttpCode(HttpStatus.OK)
  async penaltySuccess(
    @Param('profileId') profileId: string,
    @Headers('x-webhook-secret') secret: string,
  ): Promise<{ ok: boolean }> {
    const expected = this.configService.get<string>('WEBHOOK_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException();
    }
    await this.paymentService.handlePenaltyPaymentSuccess(profileId);
    return { ok: true };
  }
}
