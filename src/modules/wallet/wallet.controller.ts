import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Param,
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
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminListWalletTransactionsDto } from './dto/admin-list-wallet-transactions.dto';
import { AdminListPaymentsDto } from './dto/admin-list-payments.dto';
import { AdminWalletRevenueDto } from './dto/admin-wallet-revenue.dto';
import { AdminListMobileMoneyTransactionsDto } from './dto/admin-list-mobile-money-transactions.dto';
import { AdminRecordMobileMoneyWithdrawalDto } from './dto/admin-record-mobile-money-withdrawal.dto';
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import { MobileMoneyPayoutService } from './mobile-money-payout.service';
import {
  AdminListPayoutsDto,
  AdminSendPayoutDto,
} from './dto/admin-send-payout.dto';
import { Throttle } from '@nestjs/throttler';
import type {
  GatewayBalance,
  GatewayCountry,
} from '../../common/services/payment/types/payment-gateway.types';

/** The country the gateway balance card opens on. */
export const DEFAULT_BALANCE_COUNTRY = 'COG';

/**
 * The countries to offer, default first. When the gateway could not say
 * which countries the account has, the default alone is offered rather than
 * an empty toggle.
 */
export function balanceCountryChoices(countries: GatewayCountry[]): {
  countries: GatewayCountry[];
  default: string;
} {
  if (countries.length === 0) {
    return {
      countries: [{ code: DEFAULT_BALANCE_COUNTRY, name: 'Congo' }],
      default: DEFAULT_BALANCE_COUNTRY,
    };
  }
  const ordered = [
    ...countries.filter((c) => c.code === DEFAULT_BALANCE_COUNTRY),
    ...countries.filter((c) => c.code !== DEFAULT_BALANCE_COUNTRY),
  ];
  return { countries: ordered, default: ordered[0].code };
}

/**
 * Why this is a hand-rolled set rather than `@Roles` like every other
 * controller — it looks like an oversight and is not.
 *
 * The rule here is "ADMIN and above, **or** FINANCE". `@Roles(ADMIN)` now
 * expresses that on its own, since `LATERAL_CEILING` puts FINANCE at ADMIN
 * level and `admin/wallet` is in its area map — but only by coincidence of the
 * two numbers matching. `@Roles(MANAGER)` would still be the opposite mistake,
 * handing every MANAGER the revenue figures.
 *
 * So the set stays until the area registry lands and the two ideas — seniority
 * and ownership — stop being expressed through one decorator. It is the thing
 * that states the rule directly rather than as a consequence of a ceiling.
 */
const ALLOWED_WALLET_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  // Wallet data is this role's whole job. RolesGuard has already confirmed the
  // area is theirs; this set is the per-handler check that predates it.
  UserRole.FINANCE,
]);

@ApiTags('Wallet')
@Controller('admin/wallet')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
    private readonly logService: LogService,
    private readonly archiveService: ArchiveService,
    // Appended: the specs build this controller by position.
    private readonly paymentGateway?: PaymentGatewayService,
    private readonly payouts?: MobileMoneyPayoutService,
  ) {}

  /** Payouts move real money: SUPER_ADMIN and FINANCE only. */
  private async assertPayoutAccess(
    req: AdminAuthenticatedRequest,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (
      !user ||
      (user.role !== UserRole.SUPER_ADMIN && user.role !== UserRole.FINANCE)
    ) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN or FINANCE can send payouts',
      );
    }
  }

  private payoutService(): MobileMoneyPayoutService {
    if (!this.payouts) {
      throw new ConflictException('Payouts are not available.');
    }
    return this.payouts;
  }

  @Get('mobile-money/payouts')
  @ApiOperation({ summary: 'Payouts sent from the gateway account' })
  async listPayouts(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminListPayoutsDto,
  ) {
    await this.assertWalletAccess(req);
    return this.payoutService().list({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      status: dto.status,
    });
  }

  @Post('mobile-money/payouts')
  @HttpCode(HttpStatus.CREATED)
  // Each call can move money: a handful per window, never a loop.
  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  @ApiOperation({
    summary: 'Send money from the gateway account to a mobile-money number',
    description:
      'SUPER_ADMIN or FINANCE. The amount is typed twice and must be covered by both the ledger and the live gateway balance. The same clientRequestId never sends twice. The ledger is debited when the gateway confirms the payout.',
  })
  async sendPayout(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: AdminSendPayoutDto,
  ) {
    await this.assertPayoutAccess(req);
    return this.payoutService().send({
      clientRequestId: dto.clientRequestId,
      amount: dto.amount,
      confirmAmount: dto.confirmAmount,
      phone: dto.phone,
      operator: dto.operator,
      note: dto.note,
      adminId: req.user.userId,
    });
  }

  @Post('mobile-money/payouts/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Re-read a pending payout's status from the gateway",
  })
  async refreshPayout(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.assertWalletAccess(req);
    return this.payoutService().refresh(id);
  }

  /** Same rule as every wallet route: ADMIN and above, or FINANCE. */
  private async assertWalletAccess(
    req: AdminAuthenticatedRequest,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
  }

  /** The active gateway, when it can report balances. */
  private balanceGateway(): PaymentGatewayService {
    if (!this.paymentGateway?.supportsBalances()) {
      throw new ConflictException(
        "Le moyen de paiement actif n'expose pas de solde.",
      );
    }
    return this.paymentGateway;
  }

  @Get('gateway/balance-countries')
  @ApiOperation({
    summary: 'Countries the payment gateway account holds wallets in',
    description:
      'For the balance card toggle. COG is the default and comes first; when the gateway cannot be reached, COG alone is returned.',
  })
  @ApiResponse({
    status: 409,
    description: 'Active gateway reports no balances',
  })
  async getGatewayBalanceCountries(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ countries: GatewayCountry[]; default: string }> {
    await this.assertWalletAccess(req);
    const gateway = this.balanceGateway();
    const countries = await gateway
      .listBalanceCountries()
      .catch((): GatewayCountry[] => []);
    return balanceCountryChoices(countries);
  }

  @Get('gateway/balances')
  @ApiOperation({
    summary: 'Payment gateway account balances for one country',
    description:
      'Reads the live balances from the gateway (pawaPay: v1 wallet balances). `country` is ISO 3166-1 alpha-3 and defaults to COG.',
  })
  @ApiResponse({ status: 400, description: 'Country not available' })
  @ApiResponse({
    status: 409,
    description: 'Active gateway reports no balances',
  })
  @ApiResponse({ status: 502, description: 'Gateway unreachable' })
  async getGatewayBalances(
    @Req() req: AdminAuthenticatedRequest,
    @Query('country') country?: string,
  ): Promise<{ country: string; balances: GatewayBalance[] }> {
    await this.assertWalletAccess(req);
    const gateway = this.balanceGateway();

    const code = (country ?? DEFAULT_BALANCE_COUNTRY).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new BadRequestException('Code pays invalide (ISO 3166-1 alpha-3).');
    }
    const available = await gateway
      .listBalanceCountries()
      .catch((): GatewayCountry[] => []);
    // When the list is unknown, the gateway itself will refuse a bad country.
    if (available.length > 0 && !available.some((c) => c.code === code)) {
      throw new BadRequestException(
        "Ce pays n'est pas disponible sur le compte de paiement.",
      );
    }

    try {
      return { country: code, balances: await gateway.getBalances(code) };
    } catch {
      throw new BadGatewayException(
        'Solde indisponible : le moyen de paiement ne répond pas.',
      );
    }
  }

  @Get('revenue')
  @ApiOperation({
    summary: 'Get system revenue (admin only)',
    description:
      'Returns revenue and payment counts, optionally limited to payments created between created_from and created_to. Only users with role ADMIN, SUPER_ADMIN or FINANCE can access.',
  })
  @ApiResponse({
    status: 200,
    description: 'System revenue',
    schema: {
      type: 'object',
      properties: {
        totalRevenue: { type: 'number', example: 2348000 },
        balance: { type: 'number', example: 2348000 },
        completedCount: { type: 'number', example: 120 },
        completedPaymentsCount: { type: 'number', example: 134 },
        pendingCount: { type: 'number', example: 3 },
        failedCount: { type: 'number', example: 7 },
        revenueByType: {
          type: 'object',
          properties: {
            penalty: { type: 'number', example: 48000 },
            contactUnlock: { type: 'number', example: 2300000 },
          },
        },
        contactUnlockByMethod: {
          type: 'object',
          properties: {
            mobileMoney: { type: 'number', example: 1800000 },
            wallet: { type: 'number', example: 500000 },
            other: { type: 'number', example: 0 },
          },
        },
        walletTopUps: {
          type: 'object',
          description: 'Completed wallet top-ups — deposits, not revenue.',
          properties: {
            amount: { type: 'number', example: 700000 },
            count: { type: 'number', example: 14 },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - requires ADMIN, SUPER_ADMIN or FINANCE role',
  })
  async getRevenue(
    @Req() req: AdminAuthenticatedRequest,
    @Query() dto: AdminWalletRevenueDto,
  ): Promise<Awaited<ReturnType<WalletService['getSystemRevenue']>>> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
    return this.walletService.getSystemRevenue(dto);
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
    return this.walletService.listTransactionsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      q: dto.q,
      type: dto.type,
      created_from: dto.created_from,
      created_to: dto.created_to,
      deleted: dto.deleted,
    });
  }

  @Post('transactions/bulk-restore')
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
    await this.assertWalletRole(req);
    const result = await this.archiveService.restore(
      'wallet-transactions',
      dto.ids,
    );
    await this.logService.create({
      action: 'WALLET_TX_BULK_RESTORED',
      entityType: 'WalletTransaction',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('transactions/bulk-purge')
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
    // Purge is SUPER_ADMIN-only everywhere; wallet gates inline rather than
    // via RolesGuard, so the check is explicit here.
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (user?.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can permanently delete wallet transactions',
      );
    }
    const result = await this.archiveService.purge(
      'wallet-transactions',
      dto.ids,
    );
    await this.logService.create({
      action: 'WALLET_TX_BULK_PURGED',
      entityType: 'WalletTransaction',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('transactions/bulk-delete')
  @ApiOperation({ summary: 'Bulk archive wallet transactions (admin only)' })
  async bulkDeleteTransactions(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: BulkDeleteDto,
  ): Promise<{ count: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
    const result = await this.walletService.bulkSoftDeleteTransactions(dto.ids);
    await this.logService.create({
      action: 'WALLET_TRANSACTION_BULK_DELETED',
      entityType: 'WalletTransaction',
      userId: req.user.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
    return this.walletService.listPaymentsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      q: dto.q,
      type: dto.type,
      status: dto.status,
      method: dto.method,
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
    return this.walletService.listMobileMoneyTransactionsForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      operator: dto.operator,
      gateway: dto.gateway,
      network: dto.network,
      q: dto.q,
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
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
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

  /** Mirrors the inline gate the other wallet handlers use. */
  private async assertWalletRole(
    req: AdminAuthenticatedRequest,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN, SUPER_ADMIN or FINANCE can access wallet data',
      );
    }
  }
}
