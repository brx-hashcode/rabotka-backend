import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../../common/services/queue/queue.module';
import { NotificationModule } from '../notification/notification.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AdvertisementService } from './services/advertisement.service';
import { AdAdminService } from './services/ad-admin.service';
import { AdTargetingService } from './services/ad-targeting.service';
import { AdSchedulerService } from './services/ad-scheduler.service';
import { AdProcessor } from './services/ad.processor';
import { AdAnalyticsService } from './services/ad-analytics.service';
import { AdAdminController } from './controllers/ad-admin.controller';
import { AdTrackingController } from './controllers/ad-tracking.controller';
import { AdDevController } from './controllers/ad-dev.controller';
import { AdLinkTrackingService } from './services/ad-link-tracking.service';
import { AdNotificationService } from './services/ad-notification.service';
import { AdReportService } from './services/ad-report.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    QueueModule,
    NotificationModule,
    WhatsAppModule,
  ],
  controllers: [AdAdminController, AdTrackingController, AdDevController],
  providers: [
    AdvertisementService,
    AdAdminService,
    AdTargetingService,
    AdSchedulerService,
    AdProcessor,
    AdAnalyticsService,
    AdLinkTrackingService,
    AdNotificationService,
    AdReportService,
  ],
  exports: [AdvertisementService, AdAnalyticsService],
})
export class AdvertisementModule {}
