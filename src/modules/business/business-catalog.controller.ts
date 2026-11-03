import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
  BUSINESS_COUNTRIES,
  BUSINESS_COUNTRIES_SENTENCE,
  businessCatalog,
  DEFAULT_BUSINESS_COUNTRY,
  isBusinessCountry,
  type BusinessCountry,
} from './business-catalog';

@ApiTags('Business')
@Controller('public/business')
export class BusinessCatalogController {
  /**
   * Public: the sign-up form reads it before any account exists. Static
   * tables, no database, nothing about any business.
   */
  @Public()
  @Get('catalog')
  @ApiOperation({
    summary:
      'Business categories, legal forms, recommended documents and countries',
    description:
      'The tables a business sign-up is checked against, for one of the countries Rabotka Business is open in (CEMAC + RDC): categories in display order, the legal forms each takes and the documents each is recommended to send (all optional), the local names of the documents and official identifiers, the countries to choose from, and the headcount brackets.',
  })
  @ApiQuery({
    name: 'country',
    required: false,
    enum: BUSINESS_COUNTRIES,
    description: `ISO 3166-1 alpha-2; ${DEFAULT_BUSINESS_COUNTRY} when omitted.`,
  })
  @ApiResponse({ status: 200, description: 'The catalog' })
  @ApiResponse({ status: 400, description: 'A country outside the list' })
  getCatalog(@Query('country') country?: string) {
    const code = country?.trim();
    if (!code) return businessCatalog();
    if (!isBusinessCountry(code)) {
      throw new BadRequestException(BUSINESS_COUNTRIES_SENTENCE);
    }
    return businessCatalog(code.toUpperCase() as BusinessCountry);
  }
}
