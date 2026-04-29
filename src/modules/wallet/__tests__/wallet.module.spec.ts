import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { WalletModule } from '../wallet.module';
import { WalletService } from '../wallet.service';
import { WalletController } from '../wallet.controller';

describe('WalletModule', () => {
  it('is defined', () => {
    expect(WalletModule).toBeDefined();
  });

  it('provides WalletService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      WalletModule,
    );
    expect(providers).toContain(WalletService);
  });

  it('registers WalletController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WalletModule,
    );
    expect(controllers).toContain(WalletController);
  });

  it('exports WalletService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WalletModule,
    );
    expect(exports).toContain(WalletService);
  });
});
