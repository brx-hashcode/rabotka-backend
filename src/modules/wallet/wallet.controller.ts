import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  ForbiddenException,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import {
  WalletService,
  type AdminWalletTransactionItem,
  type AdminPaymentItem,
  type AdminMobileMoneyTransactionItem,
  type AdminMobileMoneyBalanceResult,
} from './wallet.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminListWalletTransactionsDto } from './dto/admin-list-wallet-transactions.dto';
import { AdminListPaymentsDto } from './dto/admin-list-payments.dto';
import { AdminListMobileMoneyTransactionsDto } from './dto/admin-list-mobile-money-transactions.dto';
import { AdminRecordMobileMoneyWithdrawalDto } from './dto/admin-record-mobile-money-withdrawal.dto';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

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
    private readonly logService: LogService,
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
  @ApiOperation({
    summary:
      'Monthly revenue (admin): use `year` for Jan–Dec of that year, or `rollingMonths` for a rolling window ending this month',
  })
  @ApiResponse({
    status: 200,
    description:
      'Array of { month: "YYYY-MM", revenue: number }; length is 12 for `year`, or `rollingMonths` for rolling',
  })
  async getMonthlyRevenue(
    @Req() req: AdminAuthenticatedRequest,
    @Query('year') yearStr?: string,
    @Query('rollingMonths') rollingMonthsStr?: string,
  ): Promise<{ month: string; revenue: number }[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }

    if (rollingMonthsStr !== undefined && rollingMonthsStr !== '') {
      const parsed = Number.parseInt(rollingMonthsStr, 10);
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException('Invalid rollingMonths');
      }
      return this.walletService.getMonthlyRevenueRollingMonths(parsed);
    }

    let year = new Date().getFullYear();
    if (yearStr !== undefined && yearStr !== '') {
      const parsed = Number.parseInt(yearStr, 10);
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException('Invalid year');
      }
      year = Math.min(2100, Math.max(2000, parsed));
    }

    return this.walletService.getMonthlyRevenueForCalendarYear(year);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List wallet transactions (paginated)' })
  async listTransactions(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminListWalletTransactionsDto,
  ): Promise<{
    data: AdminWalletTransactionItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
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
  ): Promise<{
    data: AdminPaymentItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
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

  @Get('mobile-money/balance')
  @ApiOperation({ summary: 'Get Mobile Money wallet balance (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Mobile Money wallet balance with operator/gateway breakdown',
  })
  async getMobileMoneyBalance(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<AdminMobileMoneyBalanceResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }
    return this.walletService.getMobileMoneyBalance();
  }

  @Get('mobile-money/transactions')
  @ApiOperation({
    summary: 'List Mobile Money wallet transactions (paginated, admin only)',
  })
  async listMobileMoneyTransactions(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminListMobileMoneyTransactionsDto,
  ): Promise<{
    data: AdminMobileMoneyTransactionItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }
    return this.walletService.listMobileMoneyTransactionsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      operator: dto.operator,
      gateway: dto.gateway,
      type: dto.type,
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }

  @Post('mobile-money/withdrawal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a Mobile Money wallet withdrawal (admin only)',
  })
  @ApiResponse({
    status: 201,
    description: 'Withdrawal recorded; returns new wallet balance',
  })
  async recordMobileMoneyWithdrawal(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: AdminRecordMobileMoneyWithdrawalDto,
  ): Promise<{ walletId: string; newBalance: number; transactionId: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }
    const result = await this.walletService.recordMobileMoneyWithdrawal(
      dto.amount,
      dto.description,
      dto.reference,
    );

    await this.logService.create({
      action: 'WALLET_WITHDRAWAL_RECORDED',
      entityType: 'wallet_transaction',
      entityId: result.transactionId,
      userId: req.user.userId,
      metadata: {
        amount: dto.amount,
        description: dto.description ?? null,
        reference: dto.reference ?? null,
        walletId: result.walletId,
        newBalance: result.newBalance,
      },
      ...extractRequestMeta(req),
    });

    return result;
  }
}
