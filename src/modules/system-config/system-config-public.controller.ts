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

  @Get('application-terms')
  @ApiOperation({
    summary: 'Terms a worker commits to when applying',
    description:
      'Feeds the confirmation sheet shown before applying, so the penalty and ' +
      'threshold the worker sees always match the ones the server enforces.',
  })
  @ApiResponse({
    status: 200,
    description: 'Late-cancellation penalty and threshold',
    schema: {
      type: 'object',
      properties: {
        lateCancellationPenaltyFcfa: { type: 'number' },
        cancellationThresholdHours: { type: 'number' },
      },
    },
  })
  async getApplicationTerms() {
    const fees = await this.systemConfigService.getFees();
    return {
      lateCancellationPenaltyFcfa: fees.lateCancellationPenaltyFcfa,
      cancellationThresholdHours: fees.cancellationThresholdHours,
    };
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
