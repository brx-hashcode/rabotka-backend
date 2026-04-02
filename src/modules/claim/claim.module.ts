import { Module } from '@nestjs/common';
import { ClaimController, ClaimCommentController, ProfileClaimController, ProfileClaimCommentController } from './claim.controller';
import { ClaimService } from './claim.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [AuthModule, NotificationModule, LogModule],
  controllers: [ClaimController, ClaimCommentController, ProfileClaimController, ProfileClaimCommentController],
  providers: [ClaimService],
  exports: [ClaimService],
})
export class ClaimModule {}
