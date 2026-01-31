import { BaseEntity } from '../../../../core/domain/base-entity';

export class HealthStatusEntity extends BaseEntity {
  status: 'ok' | 'error';
  info: Record<string, any>;
  error: Record<string, any>;
  details: Record<string, any>;

  constructor(
    status: 'ok' | 'error',
    info: Record<string, any> = {},
    error: Record<string, any> = {},
    details: Record<string, any> = {},
  ) {
    super();
    this.status = status;
    this.info = info;
    this.error = error;
    this.details = details;
  }

  isHealthy(): boolean {
    return this.status === 'ok';
  }
}
