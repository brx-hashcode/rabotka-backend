import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { CareersModule } from '../careers/careers.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  LinkedinCallbackController,
  LinkedinController,
} from './linkedin.controller';
import { LinkedinService } from './linkedin.service';

/** A team member's own LinkedIn, to post the business's offers on it. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService, which also signs the OAuth state.
  // CareersModule for the offer's social visual, the post's picture.
  imports: [
    ConfigModule,
    AuthModule,
    BusinessSubscriptionModule,
    CareersModule,
  ],
  controllers: [LinkedinController, LinkedinCallbackController],
  providers: [LinkedinService],
})
export class LinkedinModule {}
