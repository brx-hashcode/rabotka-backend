import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { CareersService } from './careers.service';

/** The public careers page of a business: no session, no contact details. */
@ApiTags('Public')
@Controller('public/careers')
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Public()
  @Get(':slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'A business and its open offers' })
  company(@Param('slug') slug: string) {
    return this.careers.company(slug);
  }

  @Public()
  @Get(':slug/offers/:reference')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'One open offer, with the questions it asks' })
  offer(@Param('slug') slug: string, @Param('reference') reference: string) {
    return this.careers.offer(slug, reference);
  }
}
