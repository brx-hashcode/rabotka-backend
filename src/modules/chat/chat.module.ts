import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FileModule } from '../file/file.module';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { ChatController } from './chat.controller';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, FileModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
