import { Controller, Get } from '@nestjs/common';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Get index message',
    description:
      'Returns an index message from the API. Language is determined by ACCEPT-LANGUAGE header (defaults to "en").',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully returns index message',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Welcome to Rabotka API!' },
        language: { type: 'string', example: 'en' },
      },
    },
  })
  getIndex(@I18n() i18n: I18nContext) {
    return this.appService.getIndex(i18n.lang);
  }
}
