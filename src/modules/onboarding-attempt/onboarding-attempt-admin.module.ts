import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OnboardingAttemptModule } from './onboarding-attempt.module';
import { OnboardingAttemptAdminController } from './onboarding-attempt-admin.controller';

@Module({
  imports: [AuthModule, OnboardingAttemptModule],
  controllers: [OnboardingAttemptAdminController],
})
export class OnboardingAttemptAdminModule {}
