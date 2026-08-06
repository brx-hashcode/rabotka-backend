import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { LoginLinkController } from './login-link.controller';
import { AuthService } from './auth.service';
import { MailModule } from '../mail/mail.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WsNotificationsModule } from '../ws-notifications/ws-notifications.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { RedisModule } from '../../common/services/redis/redis.module';
import { LogModule } from '../log/log.module';
import { JwtAuthGuard, AdminAuthGuard, RolesGuard } from './guards';
import { QrGateway } from '../ws-notifications/qr.gateway';
import { WhatsAppLoginLinkModule } from './whatsapp-login-link.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule.forRoot(),
    LogModule,
    MailModule,
    WhatsAppLoginLinkModule,
    forwardRef(() => WhatsAppModule),
    forwardRef(() => WsNotificationsModule),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwtSecret = configService.get<string>('JWT_SECRET');
        if (!jwtSecret) {
          throw new Error('JWT_SECRET environment variable is required');
        }
        return {
          secret: jwtSecret,
          signOptions: {
            // Must track AUTH_COOKIE_MAX_AGE_DAYS (see auth-cookie.util.ts).
            // A token shorter-lived than the cookie carrying it means the
            // browser keeps sending a session the server already refuses, and
            // there is no cookie-side refresh flow to recover from it.
            expiresIn: configService.get<string>('JWT_EXPIRES_IN', '30d') as
              | `${number}${'s' | 'm' | 'h' | 'd'}`
              | `${number}`,
          },
        };
      },
    }),
  ],
  controllers: [AuthController, LoginLinkController],
  providers: [AuthService, JwtAuthGuard, AdminAuthGuard, RolesGuard, QrGateway],
  exports: [
    AuthService,
    JwtAuthGuard,
    AdminAuthGuard,
    RolesGuard,
    JwtModule,
    QrGateway,
  ],
})
export class AuthModule {}
