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
    summary: 'Get hello message',
    description:
      'Returns a greeting message from the API. Language is determined by ACCEPT-LANGUAGE header (defaults to "en").',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully returns hello message',
  })
  async getHello(@I18n() i18n: I18nContext): Promise<{
    message: string;
    language: string;
  }> {
    const message = await i18n.t('test.app.greeting');
    return {
      message,
      language: i18n.lang,
    };
  }
}
