import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueService } from './queue.service';

/**
 * Email queue name constant
 */
export const EMAIL_QUEUE = 'email-queue';

/**
 * Queue Module
 *
 * Provides BullMQ queue management for email jobs using Redis.
 *
 * @example
 * ```typescript
 * constructor(private readonly queueService: QueueService) {}
 *
 * await this.queueService.addEmailJob({
 *   to: 'user@example.com',
 *   subject: 'Welcome',
 *   template: 'welcome',
 *   context: { name: 'User' },
 * });
 * ```
 */
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [ConfigModule],
      providers: [QueueService],
      exports: [QueueService],
    };
  }
}
