import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleInit,
} from '@nestjs/common';
import { ContactUnlockService } from './contact-unlock.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class ContactUnlockScheduler implements OnModuleInit {
  private readonly logger = new Logger(ContactUnlockScheduler.name);

  constructor(
    private readonly contactUnlockService: ContactUnlockService,
    @Inject(forwardRef(() => BotNotificationService))
    private readonly botNotification: BotNotificationService,
  ) {}

  onModuleInit(): void {
    setInterval(() => void this.handleExpiredUnlocks(), INTERVAL_MS);
  }

  async handleExpiredUnlocks(): Promise<void> {
    this.logger.log('Processing expired contact unlock attempts…');
    const conversions =
      await this.contactUnlockService.processExpiredAttempts();
    for (const { profileId, amount } of conversions) {
      await this.botNotification
        .sendContactUnlockCreditConversionNotification(profileId, amount)
        .catch((err) =>
          this.logger.warn(
            `Failed to send credit conversion notification to ${profileId}`,
            err,
          ),
        );
    }
  }
}
