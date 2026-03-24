import { Module, forwardRef } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [LogController],
  providers: [LogService],
  exports: [LogService],
})
export class LogModule {}
