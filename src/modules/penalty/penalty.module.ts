import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { PenaltyService } from './penalty.service';
import { AdminPenaltyController } from './admin-penalty.controller';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { LogModule } from '../log/log.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { PenaltyNotificationScheduler } from './penalty-notification.scheduler';
import { PenaltyNotificationProcessor } from './penalty-notification.processor';

@Module({
  imports: [
    AdminArchiveModule,
    PrismaModule,
    AuthModule,
    WalletModule,
    LogModule,
    WhatsAppModule,
    WhatsAppLoginLinkModule,
  ],
  controllers: [AdminPenaltyController],
  providers: [
    PenaltyService,
    PenaltyNotificationScheduler,
    PenaltyNotificationProcessor,
  ],
  exports: [PenaltyService],
})
export class PenaltyModule {}
