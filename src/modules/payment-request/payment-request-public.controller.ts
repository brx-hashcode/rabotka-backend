import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PaymentRequestService } from './payment-request.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@ApiTags('Payment')
@Controller()
export class PaymentRequestPublicController {
  constructor(private readonly service: PaymentRequestService) {}

  @Get('pay/:token')
  @ApiOperation({ summary: 'Get payment info by token' })
  getByToken(@Param('token') token: string) {
    return this.service.getByToken(token);
  }

  @Post('pay/:token/initiate')
  @ApiOperation({ summary: 'Initiate Monetbil USSD push payment' })
  initiatePayment(
    @Param('token') token: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.service.initiateMonetbilPayment(token, dto.phone, dto.operator);
  }

  @Post('webhooks/monetbil/callback')
  @ApiOperation({ summary: 'Monetbil payment webhook callback' })
  monetbilCallback(@Body() payload: Record<string, string>) {
    return this.service.handleMonetbilCallback(payload);
  }
}
