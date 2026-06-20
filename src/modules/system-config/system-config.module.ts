import { Global, Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigService } from './system-config.service';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigPublicController } from './system-config-public.controller';
import { LogModule } from '../log/log.module';
import { LayoutService } from '../mail/layout.service';

@Global()
@Module({
  imports: [forwardRef(() => AuthModule), LogModule],
  providers: [SystemConfigService, LayoutService],
  controllers: [SystemConfigController, SystemConfigPublicController],
  exports: [SystemConfigService, LayoutService],
})
export class SystemConfigModule {}
