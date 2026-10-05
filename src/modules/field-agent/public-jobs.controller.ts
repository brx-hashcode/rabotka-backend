import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentPortalService } from './agent-portal.service';

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

/**
 * The open jobs the agent app shows on its front page before anyone signs in.
 *
 * Deliberately unguarded, like `GeoPublicController`: the page is the agent
 * app's shop window. What it serves is the narrow PUBLIC_JOB_SELECT — no pay,
 * no address, no description, nothing about the employer. Signed-in agents
 * get the full shape, limited to their zones, from `GET agent/jobs`.
 */
@ApiTags('Public – Jobs')
@Controller('public/jobs')
export class PublicJobsController {
  constructor(private readonly portal: AgentPortalService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open jobs, newest first (public summary)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'country',
    required: false,
    description: 'ISO code, e.g. CG',
  })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Title or reference' })
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('country') country?: string,
    @Query('city') city?: string,
    @Query('q') q?: string,
  ) {
    return this.portal.listPublicJobs({
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
      country: country?.trim() || undefined,
      city: city?.trim() || undefined,
      q: q?.trim() || undefined,
    });
  }
}
