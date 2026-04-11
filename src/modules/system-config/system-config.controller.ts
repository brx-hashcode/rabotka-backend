import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ConfigCategory, UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SystemConfigService } from './system-config.service';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

@ApiTags('Admin – System Config')
@Controller('admin/system-configs')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@ApiBearerAuth()
@ApiCookieAuth()
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'List all system config entries (admin only)',
    description:
      'Returns all configuration keys grouped by category. Secret values are masked as "***".',
  })
  @ApiQuery({ name: 'category', enum: ConfigCategory, required: false })
  @ApiResponse({ status: 200, description: 'List of config entries' })
  list(@Query('category') category?: ConfigCategory) {
    return this.systemConfigService.getAll(category);
  }

  @Get(':key')
  @ApiOperation({
    summary: 'Get a single system config entry (admin only)',
  })
  @ApiResponse({ status: 200, description: 'Config entry' })
  @ApiResponse({ status: 404, description: 'Key not found' })
  async getOne(@Param('key') key: string) {
    const entry = await this.systemConfigService.getOne(key);
    if (!entry) throw new NotFoundException(`Config key "${key}" not found`);
    return entry;
  }

  @Patch(':key')
  @ApiOperation({
    summary: 'Update a system config value (admin only)',
    description:
      'Updates the value for the given key and invalidates the Redis cache. Changes take effect immediately for all services that read config at request time.',
  })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  @ApiResponse({ status: 404, description: 'Key not found' })
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateSystemConfigDto,
    @Req() req: any,
  ) {
    const entry = await this.systemConfigService.getOne(key);
    if (!entry) throw new NotFoundException(`Config key "${key}" not found`);
    await this.systemConfigService.set(key, dto.value, req.user?.userId);
    return { success: true };
  }
}
