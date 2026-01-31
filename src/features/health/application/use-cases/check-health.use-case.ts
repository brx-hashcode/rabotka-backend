import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckService,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { BaseUseCase } from '../../../../core/application/base-use-case.interface';
import { CheckHealthDto } from '../dto/check-health.dto';
import { HealthStatusEntity } from '../../domain/entities/health-status.entity';
import * as os from 'node:os';
import * as path from 'node:path';

@Injectable()
export class CheckHealthUseCase extends BaseUseCase<
  CheckHealthDto,
  HealthStatusEntity
> {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async execute(input: CheckHealthDto): Promise<HealthStatusEntity> {
    this.validate(input);

    const healthChecks: Array<() => Promise<any>> = [
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),
    ];

    if (input.enableDiskCheck) {
      const diskPath =
        os.platform() === 'win32' ? path.parse(process.cwd()).root : '/';

      healthChecks.push(() =>
        this.disk.checkStorage('disk', {
          thresholdPercent: input.diskThresholdPercent || 0.98,
          path: diskPath,
        }),
      );
    }

    const result = await this.health.check(healthChecks);

    const status: 'ok' | 'error' = result.status === 'ok' ? 'ok' : 'error';

    return new HealthStatusEntity(
      status,
      result.info || {},
      result.error || {},
      result.details || {},
    );
  }

  protected validate(input: CheckHealthDto): void {
    if (
      input.diskThresholdPercent !== undefined &&
      (input.diskThresholdPercent < 0 || input.diskThresholdPercent > 1)
    ) {
      throw new Error('Disk threshold must be between 0 and 1');
    }
  }
}
