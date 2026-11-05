import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import { CvScreeningModule } from '../cv-screening/cv-screening.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  CareersController,
  ExternalApplicationsController,
} from './careers.controller';
import { CareersService } from './careers.service';
import { CareersPageController } from './careers-page.controller';
import { CareersPageService } from './careers-page.service';
import { FileModule } from '../../file/file.module';
import { LogModule } from '../../log/log.module';
import { AdminExternalApplicationsController } from './admin-external-applications.controller';

/** A business's public careers page, and who applied from it. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [
    ConfigModule,
    AuthModule,
    MailModule,
    CvScreeningModule,
    BusinessSubscriptionModule,
    FileModule,
    LogModule,
  ],
  controllers: [
    CareersController,
    ExternalApplicationsController,
    CareersPageController,
    AdminExternalApplicationsController,
  ],
  providers: [CareersService, CareersPageService],
  // For rabotka-admin's view of a business (AdminBusinessService).
  // CareersService for the CV analysis queue (applicant-score).
  exports: [CareersPageService, CareersService],
})
export class CareersModule {}
