import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { HealthModule } from '../health.module';
import { HealthService } from '../health.service';
import { HealthController } from '../health.controller';

describe('HealthModule', () => {
  it('is defined', () => {
    expect(HealthModule).toBeDefined();
  });

  it('provides HealthService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      HealthModule,
    );
    expect(providers).toContain(HealthService);
  });

  it('registers HealthController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      HealthModule,
    );
    expect(controllers).toContain(HealthController);
  });
});
