import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';
import { WhatsAppModule } from '../../whatsapp/whatsapp.module';
import { ReminderProcessor } from './reminder.processor';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { SystemConfigModule } from '../../system-config/system-config.module';
import { ContactUnlockModule } from '../../contact-unlock/contact-unlock.module';
import { BotModule } from '../bot.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsAppModule),
    SystemConfigModule,
    forwardRef(() => ContactUnlockModule),
    forwardRef(() => BotModule),
  ],
  providers: [ReminderProcessor, ReminderSchedulerService],
  exports: [ReminderProcessor],
})
export class ReminderModule {}
