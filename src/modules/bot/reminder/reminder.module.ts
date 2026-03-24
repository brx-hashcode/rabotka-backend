import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';
import { WhatsAppModule } from '../../whatsapp/whatsapp.module';
import { ReminderProcessor } from './reminder.processor';
import { ReminderSchedulerService } from './reminder-scheduler.service';
@Module({
  imports: [PrismaModule, forwardRef(() => WhatsAppModule)],
  providers: [ReminderProcessor, ReminderSchedulerService],
  exports: [ReminderProcessor],
})
export class ReminderModule {}
