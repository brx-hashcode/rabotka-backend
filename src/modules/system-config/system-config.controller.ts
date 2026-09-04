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
  BadRequestException,
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
import { UpdateSystemConfigsDto } from './dto/update-system-configs.dto';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Admin – System Config')
@Controller('admin/system-configs')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@ApiBearerAuth()
@ApiCookieAuth()
export class SystemConfigController {
  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly logService: LogService,
  ) {}

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

  @Patch()
  @ApiOperation({
    summary: 'Update several system config values at once (admin only)',
    description:
      'Applies every key in one transaction, so a rejected value leaves nothing changed. Required for settings that are only valid together — the parrainage commission type decides the unit of the two credit values, and in PERCENTAGE mode they must sum to at most 100.',
  })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid value or empty body' })
  @ApiResponse({ status: 404, description: 'One or more keys not found' })
  async updateMany(
    @Body() dto: UpdateSystemConfigsDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const keys = Object.keys(dto.values ?? {});
    if (keys.length === 0) {
      throw new BadRequestException('Aucune valeur à mettre à jour');
    }

    const existing = await Promise.all(
      keys.map((key) => this.systemConfigService.getOne(key)),
    );
    const unknown = keys.filter((_, i) => existing[i] === null);
    if (unknown.length > 0) {
      throw new NotFoundException(
        `Config key(s) not found: ${unknown.join(', ')}`,
      );
    }

    await this.systemConfigService.setMany(dto.values, req.user?.userId);

    // One audit row per key, matching the single-key endpoint: the settings
    // screen saves a block, but "who changed the parrainage percentage" is
    // asked about one key, and a combined row would not answer it.
    const meta = extractRequestMeta(req);
    await Promise.all(
      keys.map((key, i) =>
        this.logService.create({
          action: 'SYSTEM_CONFIG_UPDATED',
          entityType: 'system_config',
          entityId: key,
          userId: req.user?.userId,
          metadata: {
            key,
            oldValue:
              (existing[i] as { value?: unknown } | null)?.value ?? null,
            newValue: dto.values[key],
          },
          ...meta,
        }),
      ),
    );
    return { success: true };
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
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const entry = await this.systemConfigService.getOne(key);
    if (!entry) throw new NotFoundException(`Config key "${key}" not found`);
    const oldValue = (entry as { value?: unknown })?.value ?? null;
    await this.systemConfigService.set(key, dto.value, req.user?.userId);
    await this.logService.create({
      action: 'SYSTEM_CONFIG_UPDATED',
      entityType: 'system_config',
      entityId: key,
      userId: req.user?.userId,
      metadata: { key, oldValue, newValue: dto.value },
      ...extractRequestMeta(req),
    });
    return { success: true };
  }
}
