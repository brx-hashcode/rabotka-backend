import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { BusinessCatalogController } from './business-catalog.controller';
import { BusinessController } from './business.controller';

/** Business accounts: the public catalog and the dashboard's own routes. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, ProfileModule],
  controllers: [BusinessCatalogController, BusinessController],
})
export class BusinessModule {}
