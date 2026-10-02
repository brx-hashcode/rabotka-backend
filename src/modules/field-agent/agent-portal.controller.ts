import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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
import { AgentAuthService } from './agent-auth.service';
import { AgentPortalService } from './agent-portal.service';
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
 * Read-only for now: browse the jobs in your zones and the workers suggested
 * for them. Every response is built from agent-selects.ts — no employer
 * contact, no worker phone.
 */
@ApiTags('Agent – App')
@Controller('agent')
@UseGuards(AgentAuthGuard)
@ApiBearerAuth()
export class AgentPortalController {
  constructor(
    private readonly portal: AgentPortalService,
    private readonly agentAuth: AgentAuthService,
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
  listJobs(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('q') q?: string,
  ) {
    return this.portal.listJobs(req.agent.agentId, {
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
      q: q?.trim() || undefined,
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
}
