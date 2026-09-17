import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { LogModule } from '../log/log.module';
import { OAuthModule } from '../oauth/oauth.module';
import { PartnerActivityModule } from '../partner-activity/partner-activity.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { IdentityCheckConsentController } from './identity-check-consent.controller';
import { IdentityCheckProcessor } from './identity-check.processor';
import { IdentityCheckService } from './identity-check.service';
import { IdentityCheckWebhookService } from './identity-check-webhook.service';
import { PartnerClientAuthGuard } from './guards/partner-client-auth.guard';
import { PartnerIdentityCheckController } from './partner-identity-check.controller';

/**
 * The partner identity-check API. Partners are "Login with Rabotka" apps, so
 * credentials, suspension and the signing key all come from `OAuthModule`.
 */
@Module({
  imports: [
    AuthModule,
    OAuthModule,
    PartnerActivityModule,
    LogModule,
    WhatsAppModule,
    WhatsAppLoginLinkModule,
  ],
  controllers: [PartnerIdentityCheckController, IdentityCheckConsentController],
  providers: [
    IdentityCheckService,
    IdentityCheckWebhookService,
    IdentityCheckProcessor,
    PartnerClientAuthGuard,
  ],
})
export class IdentityCheckModule {}
