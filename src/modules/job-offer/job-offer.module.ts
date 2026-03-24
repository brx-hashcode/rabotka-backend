import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferService } from './job-offer.service';
import { AdminJobOfferController } from './admin-job-offer.controller';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), forwardRef(() => WhatsAppModule), forwardRef(() => BotModule)],
  controllers: [AdminJobOfferController],
  providers: [JobOfferService],
  exports: [JobOfferService],
})
export class JobOfferModule {}
