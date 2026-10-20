import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { OnboardingAttemptService } from './onboarding-attempt.service';

/**
 * The recording side only, with no controller — so AuthModule and
 * ProfileModule can import it without a cycle. The back-office endpoints live
 * in OnboardingAttemptAdminModule, which needs AuthModule for its guards.
 */
@Module({
  imports: [PrismaModule],
  providers: [OnboardingAttemptService],
  exports: [OnboardingAttemptService],
})
export class OnboardingAttemptModule {}
