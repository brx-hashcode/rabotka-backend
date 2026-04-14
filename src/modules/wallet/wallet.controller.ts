import {
  Controller,
  Get,
  Query,
  ForbiddenException,
  UseGuards,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { WalletService, type AdminWalletTransactionItem, type AdminPaymentItem } from './wallet.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminListWalletTransactionsDto } from './dto/admin-list-wallet-transactions.dto';
import { AdminListPaymentsDto } from './dto/admin-list-payments.dto';

const ALLOWED_WALLET_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);

@ApiTags('Wallet')
@Controller('admin/wallet')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('revenue')
  @ApiOperation({
    summary: 'Get system revenue (admin only)',
    description:
      'Returns total revenue (system wallet balance). Only users with role ADMIN or SUPER_ADMIN can access.',
  })
  @ApiResponse({
    status: 200,
    description: 'System revenue',
    schema: {
      type: 'object',
      properties: {
        totalRevenue: { type: 'number', example: 2348000 },
        balance: { type: 'number', example: 2348000 },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - requires ADMIN or SUPER_ADMIN role',
  })
  async getRevenue(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ totalRevenue: number; balance: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }
    return this.walletService.getSystemRevenue();
  }

  @Get('monthly-revenue')
  @ApiOperation({ summary: 'Get monthly revenue for the last N months (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Array of { month: "YYYY-MM", revenue: number }',
  })
  async getMonthlyRevenue(
    @Req() req: AdminAuthenticatedRequest,
    @Query('months', new DefaultValuePipe(12), ParseIntPipe) months: number,
  ): Promise<{ month: string; revenue: number }[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException('Only ADMIN or SUPER_ADMIN can access wallet data');
    }
    return this.walletService.getMonthlyRevenue(months);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List wallet transactions (paginated)' })
  async listTransactions(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminListWalletTransactionsDto,
  ): Promise<{ data: AdminWalletTransactionItem[]; total: number; page: number; limit: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException('Only ADMIN or SUPER_ADMIN can access wallet data');
    }
    return this.walletService.listTransactionsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      q: dto.q,
      type: dto.type,
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }

  @Get('payments')
  @ApiOperation({ summary: 'List payments (paginated)' })
  async listPayments(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminListPaymentsDto,
  ): Promise<{ data: AdminPaymentItem[]; total: number; page: number; limit: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException('Only ADMIN or SUPER_ADMIN can access wallet data');
    }
    return this.walletService.listPaymentsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      q: dto.q,
      type: dto.type,
      status: dto.status,
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }
}
