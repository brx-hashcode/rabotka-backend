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
import { timingSafeEqual } from 'node:crypto';
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
    if (!expected || !secretMatches(secret, expected)) {
      throw new UnauthorizedException();
    }
    await this.paymentService.handlePenaltyPaymentSuccess(profileId);
    return { ok: true };
  }
}

/**
 * Constant-time comparison. `!==` stops at the first differing character, so
 * its timing tells a caller how much of a guess was right.
 */
function secretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
