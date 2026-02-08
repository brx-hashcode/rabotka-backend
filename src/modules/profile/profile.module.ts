import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { FileModule } from '../file/file.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [FileModule, MailModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
