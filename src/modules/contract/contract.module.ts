import { Module, forwardRef } from '@nestjs/common';
import {
  ContractController,
  AdminContractController,
} from './contract.controller';
import { ContractService } from './contract.service';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DocumentModule } from '../document/document.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), DocumentModule],
  controllers: [ContractController, AdminContractController],
  providers: [ContractService],
  exports: [ContractService],
})
export class ContractModule {}
