import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';

@Module({
  imports: [PrismaModule, ConfigModule, forwardRef(() => WhatsAppModule)],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
