import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailModule } from '../mail/mail.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JwtAuthGuard, AdminAuthGuard } from './guards';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailModule,
    WhatsAppModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'default-secret',
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '24h') as
            | `${number}${'s' | 'm' | 'h' | 'd'}`
            | `${number}`,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, AdminAuthGuard],
  exports: [AuthService, JwtAuthGuard, AdminAuthGuard, JwtModule],
})
export class AuthModule {}
