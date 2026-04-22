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
}
