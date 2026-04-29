import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { WhatsAppModule } from '../whatsapp.module';
import { WhatsAppService } from '../whatsapp.service';
import { WhatsAppController } from '../whatsapp.controller';

describe('WhatsAppModule', () => {
  it('is defined', () => {
    expect(WhatsAppModule).toBeDefined();
  });

  it('provides WhatsAppService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      WhatsAppModule,
    );
    expect(providers).toContain(WhatsAppService);
  });

  it('registers WhatsAppController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WhatsAppModule,
    );
    expect(controllers).toContain(WhatsAppController);
  });

  it('exports WhatsAppService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WhatsAppModule,
    );
    expect(exports).toContain(WhatsAppService);
  });
});
