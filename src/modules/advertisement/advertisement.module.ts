import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EventModule } from '../event/event.module';
import { QueueModule } from '../../common/services/queue/queue.module';
import { AdvertisementService } from './services/advertisement.service';
import { AdAdminService } from './services/ad-admin.service';
import { AdTargetingService } from './services/ad-targeting.service';
import { AdSchedulerService } from './services/ad-scheduler.service';
import { AdProcessor } from './services/ad.processor';
import { AdAnalyticsService } from './services/ad-analytics.service';
import { AdAdminController } from './controllers/ad-admin.controller';

@Module({
  imports: [PrismaModule, AuthModule, EventModule, QueueModule],
  controllers: [AdAdminController],
  providers: [
    AdvertisementService,
    AdAdminService,
    AdTargetingService,
    AdSchedulerService,
    AdProcessor,
    AdAnalyticsService,
  ],
  exports: [AdvertisementService, AdAnalyticsService],
})
export class AdvertisementModule {}
