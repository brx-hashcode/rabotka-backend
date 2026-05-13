import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Get index message',
    description: 'Returns an index message from the API.',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully returns index message',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: "Bienvenue ! L'API Rabotka est prête à vous servir.",
        },
      },
    },
  })
  getIndex() {
    return this.appService.getIndex();
  }
}
