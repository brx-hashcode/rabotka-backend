import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { MemoryHealthIndicator, DiskHealthIndicator } from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as os from 'node:os';
import * as path from 'node:path';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly configService: ConfigService,
    private readonly healthService: HealthService,
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
        status: { type: 'string', enum: ['ok', 'error'] },
        info: { type: 'object' },
        error: { type: 'object' },
        details: { type: 'object' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'One or more services are unhealthy',
  })
  async check() {
    const enableDiskCheck =
      this.configService.get<string>('HEALTH_DISK_CHECK_ENABLED', 'true') ===
      'true';
    const diskThreshold = this.configService.get<number>(
      'HEALTH_DISK_THRESHOLD_PERCENT',
      0.98,
    );

    const healthChecks: Array<() => Promise<any>> = [
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
    ];

    if (enableDiskCheck) {
      const diskPath =
        os.platform() === 'win32' ? path.parse(process.cwd()).root : '/';
      healthChecks.push(() =>
        this.disk.checkStorage('disk', {
          thresholdPercent: diskThreshold,
          path: diskPath,
        }),
      );
    }

    const result = await this.health.check(healthChecks);

    return this.healthService.formatResponse(result);
  }
}
