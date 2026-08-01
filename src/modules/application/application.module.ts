import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { ApplicationService } from './application.service';
import { AdminApplicationController } from './admin-application.controller';
import { AuthModule } from '../auth/auth.module';
import { BotModule } from '../bot/bot.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';
import { LogModule } from '../log/log.module';
import { ContractModule } from '../contract/contract.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MatchingModule } from '../matching/matching.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';

@Module({
  imports: [
    AdminArchiveModule,
    PrismaModule,
    forwardRef(() => AuthModule),
    forwardRef(() => BotModule),
    forwardRef(() => ContactUnlockModule),
    LogModule,
    ContractModule,
    SystemConfigModule,
    MatchingModule,
    RecommendationEngineModule,
  ],
  controllers: [AdminApplicationController],
  providers: [ApplicationService],
  exports: [ApplicationService],
})
export class ApplicationModule {}
