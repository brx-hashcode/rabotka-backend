import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DashboardModule } from '../dashboard.module';
import { DashboardService } from '../dashboard.service';
import { AdminDashboardController } from '../admin-dashboard.controller';

describe('DashboardModule', () => {
  it('is defined', () => {
    expect(DashboardModule).toBeDefined();
  });

  it('provides DashboardService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      DashboardModule,
    );
    expect(providers).toContain(DashboardService);
  });

  it('registers AdminDashboardController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      DashboardModule,
    );
    expect(controllers).toContain(AdminDashboardController);
  });
});
