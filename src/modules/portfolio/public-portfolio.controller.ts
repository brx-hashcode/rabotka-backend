import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { PortfolioService } from './portfolio.service';

@ApiTags('Portfolio (public)')
@Controller('public')
export class PublicPortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Public()
  @Get('workers/:slug')
  @ApiOperation({
    summary: 'Public worker portfolio by slug (no contact info exposed)',
  })
  getPublic(@Param('slug') slug: string) {
    return this.portfolioService.getPublicBySlug(slug);
  }
}
