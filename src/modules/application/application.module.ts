import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { ApplicationService } from './application.service';
import { AdminApplicationController } from './admin-application.controller';
import { AuthModule } from '../auth/auth.module';
import { BotModule } from '../bot/bot.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), forwardRef(() => BotModule), forwardRef(() => ContactUnlockModule)],
  controllers: [AdminApplicationController],
  providers: [ApplicationService],
  exports: [ApplicationService],
})
export class ApplicationModule {}
