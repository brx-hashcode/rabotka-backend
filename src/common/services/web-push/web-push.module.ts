import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WebPushService } from './web-push.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [WebPushService],
  exports: [WebPushService],
})
export class WebPushModule {}
