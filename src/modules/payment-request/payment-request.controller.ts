import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PaymentRequestService } from './payment-request.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Admin – Payment Requests')
@Controller('admin/payment-requests')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class PaymentRequestController {
  constructor(
    private readonly service: PaymentRequestService,
    private readonly logService: LogService,
    private readonly archiveService: ArchiveService,
  ) {}

  // The three siblings below declare a role; this one did not, which left the
  // financial listing open to any active admin.
  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'List all payment requests (historical)' })
  getList(@Query() dto: ListPaymentRequestsDto) {
    return this.service.getList(dto);
  }

  @Post('bulk-restore')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk restore archived rows (admin only)',
    description:
      'Clears deleted_at. Only rows that are currently archived are affected.',
  })
  @ApiResponse({ status: 201, description: 'Rows restored' })
  async bulkRestore(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.restore(
      'payment-requests',
      dto.ids,
    );
    await this.logService.create({
      action: 'PAYMENT_REQUEST_BULK_RESTORED',
      entityType: 'PaymentRequest',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-purge')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Permanently delete archived rows (SUPER_ADMIN only)',
    description:
      'Irreversible. Refuses rows carrying records that must outlive them (financial or compliance), returning 409 with the blocking counts.',
  })
  @ApiResponse({ status: 201, description: 'Rows permanently deleted' })
  @ApiResponse({ status: 409, description: 'Blocked by linked records' })
  async bulkPurge(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.purge('payment-requests', dto.ids);
    await this.logService.create({
      action: 'PAYMENT_REQUEST_BULK_PURGED',
      entityType: 'PaymentRequest',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-delete')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Bulk archive payment requests (admin only)' })
  @ApiResponse({ status: 201, description: 'Payment requests archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.service.bulkSoftDelete(dto.ids);
    await this.logService.create({
      action: 'PAYMENT_REQUEST_BULK_DELETED',
      entityType: 'PaymentRequest',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }
}
