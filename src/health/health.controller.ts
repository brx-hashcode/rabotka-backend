import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as os from 'node:os';
import * as path from 'node:path';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Check overall system health',
    description:
      'Returns the health status of all monitored services including memory and disk.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health check completed successfully',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ok', 'error'],
          description: 'Overall health status',
        },
        info: {
          type: 'object',
          description: 'Health status of individual services (when healthy)',
          additionalProperties: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['up'] },
            },
          },
        },
        error: {
          type: 'object',
          description: 'Health status of individual services (when unhealthy)',
          additionalProperties: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['down'] },
              error: { type: 'string' },
            },
          },
        },
        details: {
          type: 'object',
          description: 'Combined health status of all services',
          additionalProperties: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['up', 'down'] },
              error: { type: 'string' },
            },
          },
        },
      },
      example: {
        status: 'ok',
        info: {
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
          disk: { status: 'up' },
        },
        error: {},
        details: {
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
          disk: { status: 'up' },
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'One or more services are unhealthy',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['error'] },
        info: { type: 'object' },
        error: { type: 'object' },
        details: { type: 'object' },
      },
    },
  })
  async check() {
    const healthChecks: Array<() => Promise<any>> = [
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),
    ];

    const enableDiskCheck = this.configService.get<string>(
      'HEALTH_DISK_CHECK_ENABLED',
      'true',
    );

    if (enableDiskCheck === 'true') {
      const diskPath =
        os.platform() === 'win32' ? path.parse(process.cwd()).root : '/';

      const diskThreshold = this.configService.get<number>(
        'HEALTH_DISK_THRESHOLD_PERCENT',
        0.98,
      );

      healthChecks.push(() =>
        this.disk.checkStorage('disk', {
          thresholdPercent: diskThreshold,
          path: diskPath,
        }),
      );
    }

    return this.health.check(healthChecks);
  }
}
