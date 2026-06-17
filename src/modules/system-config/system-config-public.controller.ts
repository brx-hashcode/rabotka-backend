import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
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
  @ApiOperation({
    summary: 'Get welcome credit amount for a given profile type',
  })
  @ApiQuery({
    name: 'profileType',
    enum: ['WORKER', 'EMPLOYER'],
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Welcome credit amount in FCFA',
    schema: {
      type: 'object',
      properties: {
        creditFcfa: { type: 'number' },
      },
    },
  })
  async getWelcomeCredits(
    @Query('profileType') profileType: 'WORKER' | 'EMPLOYER',
  ) {
    const credits = await this.systemConfigService.getWelcomeCredits();
    const creditFcfa =
      profileType === 'EMPLOYER'
        ? credits.employerCreditFcfa
        : credits.workerCreditFcfa;
    return { creditFcfa };
  }
}
