import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Initiate Monetbil USSD push payment' })
  async initiatePayment(
    @Param('token') token: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    const result = await this.service.initiateMonetbilPayment(token, dto.phone, String(dto.operator));
    await this.logService.create({
      action: 'PAYMENT_INITIATED',
      entityType: 'PaymentRequest',
      metadata: { token, phone: dto.phone, operator: dto.operator },
    });
    return result;
  }

  @Post('webhooks/monetbil/callback')
  @ApiOperation({ summary: 'Monetbil payment webhook callback' })
  async monetbilCallback(@Body() payload: Record<string, string>) {
    const result = await this.service.handleMonetbilCallback(payload);
    await this.logService.create({
      action: 'PAYMENT_WEBHOOK_RECEIVED',
      entityType: 'PaymentRequest',
      metadata: { status: payload['status'], payment_ref: payload['payment_ref'] },
    });
    return result;
  }
}
