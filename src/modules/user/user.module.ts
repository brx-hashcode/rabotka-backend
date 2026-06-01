import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [AuthModule, PrismaModule, NotificationModule, LogModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
