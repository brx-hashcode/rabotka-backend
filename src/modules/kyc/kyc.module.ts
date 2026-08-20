import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AuthModule } from '../auth/auth.module';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';

@Module({
  // AuthModule for the controller's guards — it exports AdminAuthGuard and
  // RolesGuard, and without it the guards' own dependencies do not resolve.
  //
  // forwardRef, not a plain import: AuthModule reaches WhatsAppModule (via
  // LogModule), and WhatsAppModule already reaches back here. Imported
  // directly, AuthModule evaluates to undefined while that cycle is being
  // resolved and the app dies at boot with "module at index [2] is undefined".
  imports: [
    PrismaModule,
    ConfigModule,
    forwardRef(() => AuthModule),
    forwardRef(() => WhatsAppModule),
  ],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
