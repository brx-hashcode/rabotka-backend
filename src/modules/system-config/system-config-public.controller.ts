import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SystemConfigService } from './system-config.service';

@ApiTags('Public – System Config')
@Controller('public/config')
export class SystemConfigPublicController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get('contact')
  @ApiOperation({ summary: 'Get public contact information' })
  @ApiResponse({ status: 200, description: 'Contact info' })
  getContact() {
    return this.systemConfigService.getContactInfo();
  }

  @Get('welcome-credits')
  @ApiOperation({ summary: 'Get welcome credit amounts granted on registration' })
  @ApiResponse({
    status: 200,
    description: 'Welcome credit amounts in FCFA',
    schema: {
      type: 'object',
      properties: {
        workerCreditFcfa: { type: 'number' },
        employerCreditFcfa: { type: 'number' },
      },
    },
  })
  getWelcomeCredits() {
    return this.systemConfigService.getWelcomeCredits();
  }
}
