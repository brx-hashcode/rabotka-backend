import { Public } from '../auth/decorators/public.decorator';
import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentPortalService } from './agent-portal.service';
import {
  parseCategorySlugs,
  parseEmploymentTypes,
  parseSort,
  type JobListQuery,
} from './job-list-query';

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

  @Public()
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
  @ApiQuery({ name: 'sort', required: false, enum: ['recent', 'start'] })
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query() query: JobListQuery,
  ) {
    return this.portal.listPublicJobs({
      page: Math.max(page, 1),
      limit: clamp(limit, 1, 50),
      country: query.country?.trim() || undefined,
      city: query.city?.trim() || undefined,
      q: query.q?.trim() || undefined,
      employmentTypes: parseEmploymentTypes(query.employmentType),
      categories: parseCategorySlugs(query.category),
      sort: parseSort(query.sort),
    });
  }

  @Public()
  @Get(':id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'One open job (public summary)' })
  @ApiResponse({ status: 404, description: 'Unknown, closed or deleted' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.portal.getPublicJob(id);
  }
}
