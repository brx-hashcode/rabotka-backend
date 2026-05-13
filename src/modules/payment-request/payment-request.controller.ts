import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { PaymentRequestService } from './payment-request.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';

@ApiTags('Admin – Payment Requests')
@Controller('admin/payment-requests')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class PaymentRequestController {
  constructor(private readonly service: PaymentRequestService) {}

  @Get()
  @ApiOperation({ summary: 'List all payment requests (historical)' })
  getList(@Query() dto: ListPaymentRequestsDto) {
    return this.service.getList(dto);
  }
}
