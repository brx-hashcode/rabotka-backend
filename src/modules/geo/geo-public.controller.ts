import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GeoService } from './geo.service';

/**
 * Countries and cities for the location pickers.
 *
 * Deliberately unguarded, like `SystemConfigPublicController`: onboarding runs
 * before there is a session, so requiring a token here would make it impossible
 * to complete signup. Nothing served is user data — it is a static reference
 * list.
 */
@ApiTags('Public – Geo')
@Controller('public/geo')
export class GeoPublicController {
  constructor(private readonly geo: GeoService) {}

  @Get('countries')
  @ApiOperation({
    summary: 'Every country, sorted by French name',
    description:
      'Served from a dataset shipped with the image, never a third-party API — ' +
      'signup must not be able to fail because someone else is down.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'CG' },
          name: { type: 'string', example: 'Congo-Brazzaville' },
        },
      },
    },
  })
  countries() {
    return this.geo.listCountries();
  }

  @Get('countries/:code/cities')
  @ApiOperation({ summary: 'Cities of a country, sorted' })
  @ApiParam({ name: 'code', example: 'CG', description: 'ISO 3166-1 alpha-2' })
  @ApiResponse({
    status: 200,
    schema: { type: 'array', items: { type: 'string' } },
  })
  @ApiResponse({ status: 404, description: 'Unknown country code' })
  cities(@Param('code') code: string) {
    return this.geo.listCities(code);
  }
}
