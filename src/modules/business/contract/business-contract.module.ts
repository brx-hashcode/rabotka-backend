import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ContractModule } from '../../contract/contract.module';
import { BusinessContractController } from './business-contract.controller';
import { BusinessContractService } from './business-contract.service';

/** The contract of a retained candidate, from the business space. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, ContractModule],
  controllers: [BusinessContractController],
  providers: [BusinessContractService],
})
export class BusinessContractModule {}
