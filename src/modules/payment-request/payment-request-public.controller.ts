import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PaymentRequestService } from './payment-request.service';
import { SubmitPaymentDto } from './dto/submit-payment.dto';

@ApiTags('Payment')
@Controller('pay')
export class PaymentRequestPublicController {
  constructor(private readonly service: PaymentRequestService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Get payment info by token' })
  getByToken(@Param('token') token: string) {
    return this.service.getByToken(token);
  }

  @Post(':token/submit')
  @ApiOperation({ summary: 'Submit payment proof' })
  submitPayment(@Param('token') token: string, @Body() dto: SubmitPaymentDto) {
    return this.service.submitPayment(token, dto);
  }
}
