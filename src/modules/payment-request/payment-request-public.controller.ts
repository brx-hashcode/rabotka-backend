import { Public } from '../auth/decorators/public.decorator';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PaymentRequestService } from './payment-request.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import { LogService } from '../log/log.service';
import { PawapaySignatureVerifier } from '../../common/services/payment/providers/pawapay-signature';

@ApiTags('Payment')
@Controller()
export class PaymentRequestPublicController {
  constructor(
    private readonly service: PaymentRequestService,
    private readonly logService: LogService,
    private readonly pawapaySignature: PawapaySignatureVerifier,
  ) {}

  /**
   * Deliberately not under `pay/` — `pay/:token` would swallow it on any
   * reordering of this file.
   */
  @Public()
  @Get('payment-gateways')
  @ApiOperation({
    summary: 'List payment gateways and the operators each one accepts',
    description:
      'The active gateway drives the payment page; the full list lets the admin label historical rows whose gateway is no longer the active one.',
  })
  listGateways() {
    return this.service.listGateways();
  }

  @Public()
  @Get('pay/:token')
  @ApiOperation({ summary: 'Get payment info by token' })
  getByToken(@Param('token') token: string) {
    return this.service.getByToken(token);
  }

  @Public()
  @Post('pay/:token/initiate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Initiate payment via active gateway' })
  async initiatePayment(
    @Param('token') token: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    const result = await this.service.initiatePayment(
      token,
      dto.phone,
      dto.operator ?? '',
    );
    await this.logService.create({
      action: 'PAYMENT_INITIATED',
      entityType: 'PaymentRequest',
      metadata: { token, phone: dto.phone, operator: dto.operator },
    });
    return result;
  }

  /**
   * The providers' callbacks. Reachable by anyone — a provider cannot carry a
   * session or a CSRF token — and safe to be: pawaPay's must carry its
   * signature, and nothing in any body is trusted — the handler re-checks the
   * payment with the provider before acting.
   *
   * What anyone COULD do is make each call cost us a provider lookup and an
   * audit row, so both are bounded: a per-IP throttle well above what a
   * provider sends, and a cap on how much of the body is kept.
   */
  @Public()
  @Post('webhooks/payment/pawapay')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'pawaPay deposit callback (signed)',
    description:
      'Refused with 401 unless signed by pawaPay (RFC 9421, "Sign all callbacks" on in its dashboard). Even when signed, only the deposit id is read: its status is fetched back from pawaPay before anything changes.',
  })
  async pawapayDepositCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: Record<string, unknown>,
  ) {
    await this.verifyPawapay(req, payload, 'deposit');
    const result = await this.service.handlePaymentCallback(
      payload as Record<string, string>,
    );
    await this.logService.create({
      action: 'PAYMENT_WEBHOOK_RECEIVED',
      entityType: 'PaymentRequest',
      metadata: { gateway: 'PAWAPAY', payload: boundedPayload(payload) },
    });
    return result;
  }

  /**
   * Payout callbacks. Nothing initiates payouts yet, so a verified callback is
   * only recorded; it is still verified, so the log holds no forged entries.
   */
  @Public()
  @Post('webhooks/payment/pawapay/payouts')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'pawaPay payout callback (signed)' })
  async pawapayPayoutCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: Record<string, unknown>,
  ) {
    await this.verifyPawapay(req, payload, 'payout');
    await this.logService.create({
      action: 'PAYOUT_WEBHOOK_RECEIVED',
      entityType: 'Payout',
      metadata: { gateway: 'PAWAPAY', payload: boundedPayload(payload) },
    });
    return { received: true };
  }

  @Public()
  @Post('webhooks/payment/mtn-momo')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'MTN MoMo payment webhook callback' })
  async mtnMomoCallback(@Body() payload: Record<string, string>) {
    const result = await this.service.handlePaymentCallback(payload);
    await this.logService.create({
      action: 'PAYMENT_WEBHOOK_RECEIVED',
      entityType: 'PaymentRequest',
      metadata: { gateway: 'MTN_MOMO', payload: boundedPayload(payload) },
    });
    return result;
  }

  /**
   * Refuses a callback pawaPay did not sign. Recorded either way, so forged
   * attempts are visible in the audit log.
   */
  private async verifyPawapay(
    req: RawBodyRequest<Request>,
    payload: unknown,
    kind: 'deposit' | 'payout',
  ): Promise<void> {
    try {
      await this.pawapaySignature.verify({
        method: req.method,
        authority: req.headers.host ?? '',
        path: (req.originalUrl ?? req.url).split('?')[0],
        headers: req.headers,
        rawBody: req.rawBody,
      });
    } catch (err) {
      await this.logService
        .create({
          action: 'PAYMENT_WEBHOOK_REJECTED',
          entityType: kind === 'deposit' ? 'PaymentRequest' : 'Payout',
          metadata: {
            gateway: 'PAWAPAY',
            reason: 'invalid signature',
            payload: boundedPayload(payload),
          },
        })
        .catch(() => undefined);
      throw err instanceof UnauthorizedException
        ? err
        : new UnauthorizedException('Invalid callback signature');
    }
  }
}

/** Largest callback body kept in the audit log, in characters of JSON. */
const MAX_LOGGED_PAYLOAD = 4_000;

/**
 * The callback body as it should be stored: whole when it is the size a
 * provider sends, a truncated string when it is not. A real callback is a few
 * hundred bytes; anything far larger is not one, and must not become a large
 * row in the audit log for every request.
 */
export function boundedPayload(payload: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? '';
  } catch {
    return '[unserialisable payload]';
  }
  return json.length <= MAX_LOGGED_PAYLOAD
    ? payload
    : `${json.slice(0, MAX_LOGGED_PAYLOAD)}… [truncated, ${json.length} chars]`;
}
