import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { BotModule } from '../bot/bot.module';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => BotModule)],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
