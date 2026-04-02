import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { PenaltyService } from './penalty.service';
import { AdminPenaltyController } from './admin-penalty.controller';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [PrismaModule, AuthModule, WalletModule, LogModule],
  controllers: [AdminPenaltyController],
  providers: [PenaltyService],
  exports: [PenaltyService],
})
export class PenaltyModule {}
