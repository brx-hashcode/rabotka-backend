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
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AgentCommissionStatus,
  AgentLeadStatus,
  AgentWithdrawalStatus,
} from '@prisma/client';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { AgentAuthService } from './agent-auth.service';
import { AgentCommissionService } from './agent-commission.service';
import { AgentLeadService } from './agent-lead.service';
import { AgentWalletService } from './agent-wallet.service';
import { AgentWithdrawalService } from './agent-withdrawal.service';
import { AgentPortalService } from './agent-portal.service';
import {
  parseAmount,
  parseCategorySlugs,
  parseEmploymentTypes,
  parseSort,
  type JobListQuery,
} from './job-list-query';
import {
  AgentLogCallDto,
  AgentRequestWithdrawalDto,
} from './dto/agent-lead.dto';
import {
  AgentAuthGuard,
  type AgentAuthenticatedRequest,
} from './guards/agent-auth.guard';

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

/**
 * The agent app's API. Bearer-authenticated agents only (AgentAuthGuard);
 * nothing here accepts a profile or admin session.
 *
 * Browse the jobs in your zones and the workers suggested for them, then work
 * those workers as leads: claim, reveal the number, log calls, send the
 * invitation. Every response is built from whitelisted selects — no employer
 * contact, and a worker's phone only through the logged, capped reveal.
 */
@ApiTags('Agent – App')
@Controller('agent')
@UseGuards(AgentAuthGuard)
@ApiBearerAuth()
export class AgentPortalController {
  constructor(
    private readonly portal: AgentPortalService,
    private readonly agentAuth: AgentAuthService,
    private readonly leads: AgentLeadService,
    private readonly wallet: AgentWalletService,
    private readonly commissions: AgentCommissionService,
    private readonly withdrawals: AgentWithdrawalService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The signed-in agent, with their zones' })
  me(@Req() req: AgentAuthenticatedRequest) {
    return this.agentAuth.getSelf(req.agent.agentId);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Open jobs in my zones, newest first' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Title or reference' })
  @ApiQuery({
    name: 'employmentType',
    required: false,
    description: 'Comma list: MISSION,CDD,CDI,STAGE',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Comma list of category slugs',
  })
  @ApiQuery({ name: 'minAmount', required: false })
  @ApiQuery({ name: 'maxAmount', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['recent', 'start'] })
  listJobs(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query() query: JobListQuery,
  ) {
    return this.portal.listJobs(req.agent.agentId, {
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
      q: query.q?.trim() || undefined,
      employmentTypes: parseEmploymentTypes(query.employmentType),
      categories: parseCategorySlugs(query.category),
      minAmount: parseAmount(query.minAmount),
      maxAmount: parseAmount(query.maxAmount),
      sort: parseSort(query.sort),
    });
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'One job in my zones' })
  @ApiResponse({ status: 404, description: 'Not found or outside my zones' })
  getJob(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.portal.getJob(req.agent.agentId, id);
  }

  @Get('jobs/:id/candidates')
  @ApiOperation({
    summary: 'Suggested workers for one job, best first',
    description:
      'Active, verified workers who have not applied yet. No contact details.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 404, description: 'Not found or outside my zones' })
  getCandidates(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.portal.getCandidates(
      req.agent.agentId,
      id,
      clamp(limit, 1, 50),
    );
  }

  @Get('leads')
  @ApiOperation({ summary: 'My leads, most recently worked first' })
  @ApiQuery({ name: 'status', required: false, enum: AgentLeadStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listLeads(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status', new ParseEnumPipe(AgentLeadStatus, { optional: true }))
    status?: AgentLeadStatus,
  ) {
    return this.leads.listMine(req.agent.agentId, {
      status,
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
    });
  }

  @Post('leads/:id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take charge of a suggested worker',
    description:
      'First agent wins. The claim lapses after agent.lead_claim_hours without progress; claiming again renews it.',
  })
  @ApiResponse({ status: 409, description: 'Another agent holds this worker' })
  claim(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.leads.claim(req.agent.agentId, id);
  }

  @Post('leads/:id/reveal-phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "The worker's phone numbers (claimer only, logged)",
    description:
      'Counts against agent.phone_reveal_daily_cap — distinct workers per day, Brazzaville time.',
  })
  @ApiResponse({ status: 429, description: 'Daily cap reached' })
  revealPhone(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.leads.revealPhone(
      req.agent.agentId,
      id,
      extractRequestMeta(req).ipAddress,
    );
  }

  @Post('leads/:id/calls')
  @ApiOperation({
    summary: 'Record a call and its outcome (claimer only)',
    description:
      'NOT_INTERESTED closes the lead as DECLINED; UNREACHABLE and WRONG_NUMBER as UNREACHABLE. Any other outcome renews the claim.',
  })
  logCall(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentLogCallDto,
  ) {
    return this.leads.logCall(req.agent.agentId, id, dto.outcome, dto.note);
  }

  @Post('leads/:id/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get the invitation link to send the worker (claimer only)',
    description:
      'Returns the link, a ready message, and a WhatsApp share link once the number was revealed. A new link replaces the previous one.',
  })
  invite(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.leads.invite(req.agent.agentId, id);
  }

  @Get('wallet')
  @ApiOperation({
    summary: 'My balance and its movements',
    description:
      'pending: earned, in the confirmation window · available: withdrawable · locked: in a withdrawal · paidOut: transferred.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getWallet(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const agentId = req.agent.agentId;
    const [balance, movements] = await Promise.all([
      this.wallet.getBalance(agentId),
      this.wallet.listMovements(
        agentId,
        Math.max(page, 1),
        clamp(limit, 1, 50),
      ),
    ]);
    return { balance, movements };
  }

  @Get('commissions')
  @ApiOperation({ summary: 'My commissions, one per placement, newest first' })
  @ApiQuery({ name: 'status', required: false, enum: AgentCommissionStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listCommissions(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query(
      'status',
      new ParseEnumPipe(AgentCommissionStatus, { optional: true }),
    )
    status?: AgentCommissionStatus,
  ) {
    return this.commissions.list(req.agent.agentId, {
      status,
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
    });
  }

  @Post('withdrawals')
  @ApiOperation({
    summary: 'Ask to withdraw part of my available balance',
    description:
      'Paid by hand to the Mobile Money number (default: my phone). The amount is locked until an admin pays or rejects it. One open request at a time; minimum agent.withdrawal_min_fcfa.',
  })
  @ApiResponse({
    status: 400,
    description: 'Under the minimum, or over the balance',
  })
  @ApiResponse({ status: 409, description: 'A request is already open' })
  requestWithdrawal(
    @Req() req: AgentAuthenticatedRequest,
    @Body() dto: AgentRequestWithdrawalDto,
  ) {
    return this.withdrawals.request(req.agent.agentId, dto);
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'My withdrawals, newest first' })
  @ApiQuery({ name: 'status', required: false, enum: AgentWithdrawalStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listWithdrawals(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query(
      'status',
      new ParseEnumPipe(AgentWithdrawalStatus, { optional: true }),
    )
    status?: AgentWithdrawalStatus,
  ) {
    return this.withdrawals.list({
      agentId: req.agent.agentId,
      status,
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
    });
  }
}
