import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { LogModule } from '../log.module';
import { LogService } from '../log.service';
import { LogController } from '../log.controller';

describe('LogModule', () => {
  it('is defined', () => {
    expect(LogModule).toBeDefined();
  });

  it('provides LogService', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LogModule);
    expect(providers).toContain(LogService);
  });

  it('registers LogController', () => {
    const controllers: unknown[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, LogModule);
    expect(controllers).toContain(LogController);
  });

  it('exports LogService', () => {
    const exports: unknown[] = Reflect.getMetadata(MODULE_METADATA.EXPORTS, LogModule);
    expect(exports).toContain(LogService);
  });
});
