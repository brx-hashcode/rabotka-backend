import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AgentWithdrawalStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AgentWithdrawalService } from './agent-withdrawal.service';
import {
  PayAgentWithdrawalDto,
  RejectAgentWithdrawalDto,
} from './dto/admin-agent.dto';

/**
 * Agents' withdrawal requests: the queue an admin works, and the two
 * decisions. Paying is manual — send the Mobile Money transfer first, then
 * record its reference here.
 */
@ApiTags('Admin – Agents')
@ApiBearerAuth()
@ApiCookieAuth()
@Controller('admin/agent-withdrawals')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminAgentWithdrawalController {
  constructor(private readonly withdrawals: AgentWithdrawalService) {}

  @Get()
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Withdrawals — every agent, or one',
    description: 'status=REQUESTED is the queue, oldest first.',
  })
  @ApiQuery({ name: 'status', required: false, enum: AgentWithdrawalStatus })
  @ApiQuery({ name: 'agentId', required: false })
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query(
      'status',
      new ParseEnumPipe(AgentWithdrawalStatus, { optional: true }),
    )
    status?: AgentWithdrawalStatus,
    @Query('agentId', new ParseUUIDPipe({ optional: true })) agentId?: string,
  ) {
    return this.withdrawals.list({
      agentId,
      status,
      page: Math.max(page, 1),
      limit: Math.min(Math.max(limit, 1), 100),
    });
  }

  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Record the Mobile Money transfer as paid' })
  @ApiResponse({
    status: 409,
    description: 'Already processed, or the reference was used before',
  })
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayAgentWithdrawalDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.withdrawals.pay(id, req.user.userId, dto.reference);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Refuse it; the amount goes back to available' })
  @ApiResponse({ status: 409, description: 'Already processed' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectAgentWithdrawalDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.withdrawals.reject(id, req.user.userId, dto.reason);
  }
}
