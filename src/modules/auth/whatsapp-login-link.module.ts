import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WhatsAppLoginLinkService } from './whatsapp-login-link.service';

/**
 * Standalone on purpose: both AuthModule (which consumes codes) and
 * WhatsAppModule (which mints them on outbound templates) need this service,
 * and those two already reference each other through forwardRef. Keeping it in
 * its own leaf module — Redis is global, Prisma is all it adds — avoids
 * deepening that cycle.
 */
@Module({
  imports: [PrismaModule],
  providers: [WhatsAppLoginLinkService],
  exports: [WhatsAppLoginLinkService],
})
export class WhatsAppLoginLinkModule {}
