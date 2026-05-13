import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ApplicationModule } from '../application.module';
import { ApplicationService } from '../application.service';
import { AdminApplicationController } from '../admin-application.controller';

describe('ApplicationModule', () => {
  it('is defined', () => {
    expect(ApplicationModule).toBeDefined();
  });

  it('provides ApplicationService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ApplicationModule,
    );
    expect(providers).toContain(ApplicationService);
  });

  it('registers AdminApplicationController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ApplicationModule,
    );
    expect(controllers).toContain(AdminApplicationController);
  });

  it('exports ApplicationService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      ApplicationModule,
    );
    expect(exports).toContain(ApplicationService);
  });
});
