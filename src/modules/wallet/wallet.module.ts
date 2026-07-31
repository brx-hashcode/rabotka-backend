import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
import { Module, forwardRef } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [
    AdminArchiveModule,
    forwardRef(() => AuthModule),
    SystemConfigModule,
    InvoiceModule,
    LogModule,
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
