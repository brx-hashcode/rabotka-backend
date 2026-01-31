import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  formatResponse(result: {
    status: string;
    info?: Record<string, any>;
    error?: Record<string, any>;
    details?: Record<string, any>;
  }) {
    const status: 'ok' | 'error' = result.status === 'ok' ? 'ok' : 'error';
    return {
      status,
      info: result.info ?? {},
      error: result.error ?? {},
      details: result.details ?? {},
    };
  }
}
