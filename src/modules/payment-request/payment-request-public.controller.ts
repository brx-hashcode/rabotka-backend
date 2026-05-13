import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PaymentRequestService } from './payment-request.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import { LogService } from '../log/log.service';

@ApiTags('Payment')
@Controller()
export class PaymentRequestPublicController {
  constructor(
    private readonly service: PaymentRequestService,
    private readonly logService: LogService,
  ) {}

  @Get('pay/:token')
  @ApiOperation({ summary: 'Get payment info by token' })
  getByToken(@Param('token') token: string) {
    return this.service.getByToken(token);
  }

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
      String(dto.operator),
    );
    await this.logService.create({
      action: 'PAYMENT_INITIATED',
      entityType: 'PaymentRequest',
      metadata: { token, phone: dto.phone, operator: dto.operator },
    });
    return result;
  }

  @Post('webhooks/payment/callback')
  @ApiOperation({ summary: 'Payment gateway webhook callback (Monetbil)' })
  async paymentCallback(@Body() payload: Record<string, string>) {
    const result = await this.service.handlePaymentCallback(payload);
    await this.logService.create({
      action: 'PAYMENT_WEBHOOK_RECEIVED',
      entityType: 'PaymentRequest',
      metadata: { payload },
    });
    return result;
  }

  @Post('webhooks/payment/mtn-momo')
  @ApiOperation({ summary: 'MTN MoMo payment webhook callback' })
  async mtnMomoCallback(@Body() payload: Record<string, string>) {
    const result = await this.service.handlePaymentCallback(payload);
    await this.logService.create({
      action: 'PAYMENT_WEBHOOK_RECEIVED',
      entityType: 'PaymentRequest',
      metadata: { gateway: 'MTN_MOMO', payload },
    });
    return result;
  }
}
