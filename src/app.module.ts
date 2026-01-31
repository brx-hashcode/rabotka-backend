import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
import * as path from 'node:path';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AppFeatureModule } from './features/app/app.module';
import { HealthModule } from './features/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
      expandVariables: true,
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      fallbacks: {
        'en-*': 'en',
      },
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: true,
      },
      resolvers: [
        new AcceptLanguageResolver({
          matchType: 'strict',
        }),
      ],
    }),
    DatabaseModule,
    AppFeatureModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
