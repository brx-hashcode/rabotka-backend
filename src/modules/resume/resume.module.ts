import { Module, forwardRef } from '@nestjs/common';
import { ResumeController } from './resume.controller';
import { AdminResumeController } from './admin-resume.controller';
import { BusinessResumeController } from './business-resume.controller';
import { BusinessSubscriptionModule } from '../business/subscription/business-subscription.module';
import { ResumeService } from './resume.service';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    BusinessSubscriptionModule,
  ],
  controllers: [
    ResumeController,
    AdminResumeController,
    BusinessResumeController,
  ],
  providers: [ResumeService],
  exports: [ResumeService],
})
export class ResumeModule {}
