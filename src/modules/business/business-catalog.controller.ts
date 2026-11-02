import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { businessCatalog } from './business-catalog';

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
    summary: 'Business categories, legal forms and required documents',
    description:
      'The tables a business sign-up is checked against (Congo-Brazzaville): categories in display order, the legal forms and documents each takes, and the headcount brackets.',
  })
  @ApiResponse({ status: 200, description: 'The catalog' })
  getCatalog() {
    return businessCatalog();
  }
}
