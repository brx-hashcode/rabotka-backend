import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import {
  AdminDemoRequestController,
  DemoRequestPublicController,
} from './demo-request.controller';
import { DemoRequestListener } from './demo-request.listener';
import { DemoRequestService } from './demo-request.service';

/** « Demander une démo »: the public form, and staff's follow-up in admin. */
@Module({
  // AuthModule for AdminAuthGuard's JwtService.
  imports: [ConfigModule, AuthModule, MailModule],
  controllers: [DemoRequestPublicController, AdminDemoRequestController],
  providers: [DemoRequestService, DemoRequestListener],
})
export class DemoRequestModule {}
