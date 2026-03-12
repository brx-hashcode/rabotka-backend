import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { FileModule } from '../file.module';
import { FileService } from '../file.service';
import { FileController } from '../file.controller';

describe('FileModule', () => {
  it('is defined', () => {
    expect(FileModule).toBeDefined();
  });

  it('provides FileService', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FileModule);
    expect(providers).toContain(FileService);
  });

  it('registers FileController', () => {
    const controllers: unknown[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FileModule);
    expect(controllers).toContain(FileController);
  });

  it('exports FileService', () => {
    const exports: unknown[] = Reflect.getMetadata(MODULE_METADATA.EXPORTS, FileModule);
    expect(exports).toContain(FileService);
  });
});
