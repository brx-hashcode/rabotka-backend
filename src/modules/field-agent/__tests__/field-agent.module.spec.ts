import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminAgentController } from '../admin-agent.controller';
import { AdminAgentService } from '../admin-agent.service';
import { AgentAuthController } from '../agent-auth.controller';
import { AgentAuthService } from '../agent-auth.service';
import { AgentInviteService } from '../agent-invite.service';
import { AgentLeadService } from '../agent-lead.service';
import { AgentPortalController } from '../agent-portal.controller';
import { AgentPortalService } from '../agent-portal.service';
import { AgentWalletService } from '../agent-wallet.service';
import { FieldAgentModule } from '../field-agent.module';
import { AgentAuthGuard } from '../guards/agent-auth.guard';
import { ProfileAgentInviteController } from '../profile-agent-invite.controller';

describe('FieldAgentModule', () => {
  it('registers the agent-app, login and back-office controllers', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      FieldAgentModule,
    );
    expect(controllers).toEqual(
      expect.arrayContaining([
        AgentAuthController,
        AgentPortalController,
        AdminAgentController,
        ProfileAgentInviteController,
      ]),
    );
  });

  it('provides its services and the guard its controllers mount', () => {
    // AgentAuthGuard injects services, so Nest must be able to build it from
    // this module — a guard missing here fails at the first request, not boot.
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      FieldAgentModule,
    );
    expect(providers).toEqual(
      expect.arrayContaining([
        AgentAuthService,
        AgentPortalService,
        AdminAgentService,
        AgentWalletService,
        AgentLeadService,
        AgentInviteService,
        AgentAuthGuard,
      ]),
    );
  });
});
