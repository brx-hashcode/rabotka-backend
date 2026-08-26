import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { MailModule } from '../mail/mail.module';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { AdminReferralController } from './admin-referral.controller';

/**
 * PrismaModule, SystemConfigModule and AdminCacheModule are all @Global, so
 * only the real edges are declared here. LayoutService arrives via
 * SystemConfigModule, which exports it.
 *
 * AuthModule is behind forwardRef for the same reason PortfolioModule does it:
 * the guards live there, and AuthModule sits inside the Bot ↔ WhatsApp ↔ Auth
 * import cycle, so a direct reference resolves to undefined at module
 * evaluation time.
 */
@Module({
  imports: [
    forwardRef(() => AuthModule),
    WalletModule,
    MailModule,
    ConfigModule,
  ],
  controllers: [ReferralController, AdminReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
