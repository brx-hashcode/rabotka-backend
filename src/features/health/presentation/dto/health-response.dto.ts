import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({
    description: 'Overall health status',
    enum: ['ok', 'error'],
    example: 'ok',
  })
  status: 'ok' | 'error';

  @ApiProperty({
    description: 'Health status of individual services (when healthy)',
    type: Object,
    additionalProperties: true,
    example: {
      memory_heap: { status: 'up' },
      memory_rss: { status: 'up' },
      disk: { status: 'up' },
    },
  })
  info: Record<string, any>;

  @ApiProperty({
    description: 'Health status of individual services (when unhealthy)',
    type: Object,
    additionalProperties: true,
    example: {},
  })
  error: Record<string, any>;

  @ApiProperty({
    description: 'Combined health status of all services',
    type: Object,
    additionalProperties: true,
    example: {
      memory_heap: { status: 'up' },
      memory_rss: { status: 'up' },
      disk: { status: 'up' },
    },
  })
  details: Record<string, any>;

  constructor(
    status: 'ok' | 'error',
    info: Record<string, any>,
    error: Record<string, any>,
    details: Record<string, any>,
  ) {
    this.status = status;
    this.info = info;
    this.error = error;
    this.details = details;
  }
}
