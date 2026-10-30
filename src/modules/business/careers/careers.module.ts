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

/** A business's public careers page, and who applied from it. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [
    ConfigModule,
    AuthModule,
    MailModule,
    CvScreeningModule,
    BusinessSubscriptionModule,
  ],
  controllers: [CareersController, ExternalApplicationsController],
  providers: [CareersService],
})
export class CareersModule {}
