import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { AdminProfileController } from './admin-profile.controller';
import { ProfileService } from './profile.service';
import { FileModule } from '../file/file.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WalletModule } from '../wallet/wallet.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [FileModule, MailModule, AuthModule, WhatsAppModule, WalletModule, LogModule],
  controllers: [ProfileController, AdminProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
