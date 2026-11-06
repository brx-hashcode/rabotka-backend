import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { HrExportsController } from './hr-exports.controller';
import { HrExportsService } from './hr-exports.service';

/** « Exports RH »: candidates, staff register, ACPE declaration. */
@Module({
  imports: [AuthModule, BusinessSubscriptionModule],
  controllers: [HrExportsController],
  providers: [HrExportsService],
})
export class HrExportsModule {}
