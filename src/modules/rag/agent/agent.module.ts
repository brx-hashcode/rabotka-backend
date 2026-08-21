import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmModule } from '../llm/llm.module';
import { IntentsModule } from '../intents/intents.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { GuardService } from './guard.service';
import { VovaAgentService } from './agent.service';
import { ToolDepsProvider } from './tool-deps.provider';
import { VovaHistoryService } from './history.service';
import { AbuseReportService } from './abuse-report.service';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';

/**
 * The agent.
 *
 * Imports only self-contained modules on purpose. The services the tools call
 * are resolved through {@link ToolDepsProvider} rather than imported — see the
 * comment there for the require cycle that forced it.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LlmModule,
    IntentsModule,
    RetrievalModule,
  ],
  providers: [
    GuardService,
    VovaAgentService,
    ToolDepsProvider,
    VovaHistoryService,
    AbuseReportService,
  ],
  exports: [VovaAgentService, GuardService],
})
export class VovaAgentModule {}
