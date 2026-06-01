import { Global, Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigService } from './system-config.service';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigPublicController } from './system-config-public.controller';
import { LogModule } from '../log/log.module';

@Global()
@Module({
  imports: [forwardRef(() => AuthModule), LogModule],
  providers: [SystemConfigService],
  controllers: [SystemConfigController, SystemConfigPublicController],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
