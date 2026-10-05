import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApplicationModule } from '../application/application.module';
import { AuthModule } from '../auth/auth.module';
import { FileModule } from '../file/file.module';
import { LogModule } from '../log/log.module';
import { MailModule } from '../mail/mail.module';
import { MatchingModule } from '../matching/matching.module';
import { NotificationDispatchModule } from '../notification-dispatch/notification-dispatch.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';
import { AdminAgentWithdrawalController } from './admin-agent-withdrawal.controller';
import { AdminAgentController } from './admin-agent.controller';
import { AdminAgentService } from './admin-agent.service';
import { AgentAuthController } from './agent-auth.controller';
import { AgentAuthService } from './agent-auth.service';
import { AgentCommissionScheduler } from './agent-commission.scheduler';
import { AgentCommissionService } from './agent-commission.service';
import { AgentInviteService } from './agent-invite.service';
import { AgentLeadService } from './agent-lead.service';
import { AgentPortalController } from './agent-portal.controller';
import { AgentPortalService } from './agent-portal.service';
import { AgentWalletService } from './agent-wallet.service';
import { AgentWithdrawalService } from './agent-withdrawal.service';
import { AgentStatsService } from './agent-stats.service';
import { AgentAuthGuard } from './guards/agent-auth.guard';
import { ProfileAgentInviteController } from './profile-agent-invite.controller';
import { PublicJobsController } from './public-jobs.controller';

/**
 * Field agents: the people who call workers on Rabotka's behalf, from their
 * own app. Named `field-agent` because `rag/agent` is already the VoVa
 * assistant.
 *
 * PrismaModule, SystemConfigModule (with LayoutService), StorageModule and
 * GeoModule are @Global, so only the real edges are declared. AuthModule is
 * behind forwardRef for the reason ReferralModule gives: it sits inside the
 * Bot ↔ WhatsApp ↔ Auth cycle. It provides JwtModule and AuthService
 * (revokeToken) here.
 */
@Module({
  imports: [
    ConfigModule,
    ApplicationModule,
    forwardRef(() => AuthModule),
    FileModule,
    LogModule,
    MailModule,
    MatchingModule,
    forwardRef(() => NotificationDispatchModule),
    RecommendationEngineModule,
  ],
  controllers: [
    AgentAuthController,
    AgentPortalController,
    AdminAgentController,
    AdminAgentWithdrawalController,
    ProfileAgentInviteController,
    PublicJobsController,
  ],
  providers: [
    AgentAuthService,
    AgentPortalService,
    AdminAgentService,
    AgentWalletService,
    AgentStatsService,
    AgentLeadService,
    AgentInviteService,
    AgentCommissionService,
    AgentCommissionScheduler,
    AgentWithdrawalService,
    AgentAuthGuard,
  ],
})
export class FieldAgentModule {}
