import { Controller, Get } from '@nestjs/common';
import { HealthCheck } from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { BaseController } from '../../../../core/presentation/base-controller';
import { CheckHealthUseCase } from '../../application/use-cases/check-health.use-case';
import { CheckHealthDto } from '../../application/dto/check-health.dto';
import { HealthResponseDto } from '../dto/health-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController extends BaseController {
  constructor(
    private readonly checkHealthUseCase: CheckHealthUseCase,
    private readonly configService: ConfigService,
  ) {
    super();
  }

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
    type: HealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: 'One or more services are unhealthy',
    type: HealthResponseDto,
  })
  async check(): Promise<HealthResponseDto> {
    const enableDiskCheck = this.configService.get<string>(
      'HEALTH_DISK_CHECK_ENABLED',
      'true',
    );

    const diskThreshold = this.configService.get<number>(
      'HEALTH_DISK_THRESHOLD_PERCENT',
      0.98,
    );

    const input = new CheckHealthDto(enableDiskCheck === 'true', diskThreshold);

    const entity = await this.checkHealthUseCase.execute(input);

    return new HealthResponseDto(
      entity.status,
      entity.info,
      entity.error,
      entity.details,
    );
  }
}
