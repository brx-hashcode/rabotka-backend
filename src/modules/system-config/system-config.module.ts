import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigService } from './system-config.service';
import { SystemConfigController } from './system-config.controller';

@Global()
@Module({
  imports: [AuthModule],
  providers: [SystemConfigService],
  controllers: [SystemConfigController],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
