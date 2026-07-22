import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { SendTimingService } from './send-timing.service';
import { SendTimingInterceptor } from './send-timing.interceptor';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [SendTimingService, SendTimingInterceptor],
  exports: [SendTimingService, SendTimingInterceptor],
})
export class WhatsAppTelemetryModule {}
