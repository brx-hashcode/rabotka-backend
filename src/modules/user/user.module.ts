import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [AuthModule, PrismaModule, NotificationModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
