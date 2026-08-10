import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WHATSAPP_PROVIDER, type WhatsappProvider } from './contracts';
import { parseWhatsappConfig } from './whatsapp.config';
import { TwilioProvider } from './providers/twilio/twilio.provider';

/**
 * Resolves the active provider once, at boot, from validated config.
 *
 * Both providers are registered as classes; only this factory decides which one
 * answers the `WHATSAPP_PROVIDER` token. Nothing else in the application may
 * inject a concrete provider — that is what makes the switch a single
 * environment variable rather than a code change.
 */
export function createWhatsappProvider(
  config: ConfigService,
  twilio: TwilioProvider,
): WhatsappProvider {
  const logger = new Logger('WhatsAppProvider');
  const resolved = parseWhatsappConfig(process.env);

  if (resolved.provider === 'cloud') {
    // Replaced by CloudProvider in the commit that adds it. Failing here rather
    // than silently falling back to Twilio: a deploy that asked for `cloud` and
    // quietly kept sending through Twilio is the worst of both outcomes.
    throw new Error(
      'WHATSAPP_PROVIDER=cloud is not available in this build yet. ' +
        'Set WHATSAPP_PROVIDER=twilio.',
    );
  }

  logger.log(
    `WhatsApp provider: twilio (configured=${twilio.isConfigured()}, from=${config.get<string>('TWILIO_WHATSAPP_FROM') ?? 'unset'})`,
  );
  return twilio;
}

export const whatsappProviderFactory: Provider = {
  provide: WHATSAPP_PROVIDER,
  useFactory: createWhatsappProvider,
  inject: [ConfigService, TwilioProvider],
};
