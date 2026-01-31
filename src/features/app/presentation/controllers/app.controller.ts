import { Controller, Get } from '@nestjs/common';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BaseController } from '../../../../core/presentation/base-controller';
import { GetHelloUseCase } from '../../application/use-cases/get-hello.use-case';
import { GetHelloDto } from '../../application/dto/get-hello.dto';
import { GetHelloResponseDto } from '../dto/get-hello-response.dto';

@ApiTags('App')
@Controller()
export class AppController extends BaseController {
  constructor(private readonly getHelloUseCase: GetHelloUseCase) {
    super();
  }

  @Get()
  @ApiOperation({
    summary: 'Get hello message',
    description:
      'Returns a greeting message from the API. Language is determined by ACCEPT-LANGUAGE header (defaults to "en").',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully returns hello message',
    type: GetHelloResponseDto,
  })
  async getHello(@I18n() i18n: I18nContext): Promise<GetHelloResponseDto> {
    const input = new GetHelloDto(i18n.lang);
    const entity = await this.getHelloUseCase.execute(input);

    return new GetHelloResponseDto(entity.greeting, entity.language);
  }
}
