import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
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
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { PaymentRequestModule } from '../payment-request/payment-request.module';
import { DocumentModule } from '../document/document.module';
import { MatchingModule } from '../matching/matching.module';
import { InterestGraphModule } from '../interest-graph/interest-graph.module';
import { GeocodingModule } from '../../common/services/geocoding/geocoding.module';
import { PortfolioModule } from '../portfolio/portfolio.module';

@Module({
  imports: [
    AdminArchiveModule,
    FileModule,
    MailModule,
    AuthModule,
    WhatsAppModule,
    WalletModule,
    LogModule,
    PrismaModule,
    PaymentRequestModule,
    DocumentModule,
    MatchingModule,
    InterestGraphModule,
    GeocodingModule,
    PortfolioModule,
  ],
  controllers: [ProfileController, AdminProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
