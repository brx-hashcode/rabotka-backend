import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { PaymentRequestService } from './payment-request.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';

@ApiTags('Admin – Payment Requests')
@Controller('admin/payment-requests')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class PaymentRequestController {
  constructor(private readonly service: PaymentRequestService) {}

  @Post()
  @ApiOperation({ summary: 'Create a payment link for a profile' })
  createPaymentLink(@Body() dto: CreatePaymentLinkDto, @Req() req: any) {
    return this.service.createPaymentLink(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'List all payment requests' })
  getList(@Query() dto: ListPaymentRequestsDto) {
    return this.service.getList(dto);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a submitted payment request' })
  approve(@Param('id') id: string, @Req() req: any) {
    return this.service.approve(id, req.user.id);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a submitted payment request' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectPaymentDto,
    @Req() req: any,
  ) {
    return this.service.reject(id, dto, req.user.id);
  }
}
