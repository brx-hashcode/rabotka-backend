import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { BusinessSubscriptionScheduler } from './business-subscription.scheduler';
import { BusinessSubscriptionService } from './business-subscription.service';

/**
 * The subscription core: periods, quotas, features, expiry. Imported by the
 * flows that consult it (contact unlocks, job offers, preselection, field
 * agents); it imports none of them.
 */
@Module({
  imports: [MailModule],
  providers: [BusinessSubscriptionService, BusinessSubscriptionScheduler],
  exports: [BusinessSubscriptionService],
})
export class BusinessSubscriptionModule {}
