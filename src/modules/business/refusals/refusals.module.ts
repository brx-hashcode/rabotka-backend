import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ApplicationModule } from '../../application/application.module';
import { BulkRefuseController } from './bulk-refuse.controller';
import { BulkRefuseService } from './bulk-refuse.service';

/** Refusals in bulk on an offer, from the business space. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, ApplicationModule],
  controllers: [BulkRefuseController],
  providers: [BulkRefuseService],
})
export class RefusalsModule {}
