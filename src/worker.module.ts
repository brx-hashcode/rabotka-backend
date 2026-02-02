import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';

/**
 * Minimal module for the queue worker process.
 * MailModule registers MailProcessor only when RUN_QUEUE_WORKER=true (set in worker.ts).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
      expandVariables: true,
    }),
    PrismaModule,
    MailModule,
  ],
})
export class WorkerModule {}
