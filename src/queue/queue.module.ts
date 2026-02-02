import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueService } from './queue.service';

export const EMAIL_QUEUE = 'email-queue';

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
