import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NotificationModule } from '../notification.module';
import { NotificationService } from '../notification.service';

describe('NotificationModule', () => {
  it('is defined', () => {
    expect(NotificationModule).toBeDefined();
  });

  it('provides NotificationService', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NotificationModule);
    expect(providers).toContain(NotificationService);
  });

  it('exports NotificationService', () => {
    const exports: unknown[] = Reflect.getMetadata(MODULE_METADATA.EXPORTS, NotificationModule);
    expect(exports).toContain(NotificationService);
  });
});
