import {
  Controller,
  Get,
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
import { WalletService } from './wallet.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/services/prisma/prisma.service';

const ALLOWED_WALLET_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

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
  @ApiResponse({ status: 403, description: 'Forbidden - requires ADMIN or SUPER_ADMIN role' })
  async getRevenue(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ totalRevenue: number; balance: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });
    if (!user || !ALLOWED_WALLET_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        'Only ADMIN or SUPER_ADMIN can access wallet data',
      );
    }
    return this.walletService.getSystemRevenue();
  }
}
