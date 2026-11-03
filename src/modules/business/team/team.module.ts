import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { BusinessMemberInterceptor } from './business-member.interceptor';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

/** The people of a business, their roles and their activity. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, MailModule, BusinessSubscriptionModule],
  controllers: [TeamController],
  providers: [
    TeamService,
    // Global: the role check and the activity log cover the shared routes
    // the business space calls too, not only this module's.
    { provide: APP_INTERCEPTOR, useClass: BusinessMemberInterceptor },
  ],
  exports: [TeamService],
})
export class TeamModule {}
