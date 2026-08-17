import { Module, forwardRef } from '@nestjs/common';
import { WhatsappAdminController } from './whatsapp-admin.controller';
import { WhatsappAdminService } from './whatsapp-admin.service';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { LogModule } from '../log/log.module';
import { WhatsappLogRetentionService } from './whatsapp-log-retention.service';

/**
 * The WhatsApp back office: delivery log, statistics, Meta consumption, queue.
 *
 * Read-only apart from the dead-letter retry, and deliberately NOT part of
 * `WhatsAppModule`. That module is on the send path and is imported by half the
 * application including the worker process; reporting aggregates have no
 * business in that graph.
 *
 * `AdminCacheService` and `QueueService` come from globally-registered modules
 * (`AdminCacheModule` and `QueueModule.forRoot()`), so they need no import here.
 */
@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), LogModule],
  controllers: [WhatsappAdminController],
  providers: [WhatsappAdminService, WhatsappLogRetentionService],
  exports: [WhatsappAdminService],
})
export class WhatsappAdminModule {}
