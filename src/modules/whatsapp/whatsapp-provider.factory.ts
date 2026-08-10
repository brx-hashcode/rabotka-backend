import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WHATSAPP_PROVIDER,
  type ProviderName,
  type WhatsappProvider,
} from './contracts';
import {
  WHATSAPP_TEMPLATES,
  findTemplateBindingProblems,
} from '../../common/constants/whatsapp-templates';
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

  assertTemplateBindings(resolved.provider, logger);

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

/**
 * Refuse to boot if any template cannot be sent on the active provider.
 *
 * The env overrides are the reason this exists: `TPL_KYC_APPROVED=` in a
 * deployment resolves to an empty string, and an empty SID is a send that
 * silently does nothing. Failing here surfaces it on the deploy that introduced
 * it rather than the first time that notification fires.
 *
 * Only the ACTIVE provider is checked — a blank Cloud name must not block a
 * deploy that is still running on Twilio.
 */
export function assertTemplateBindings(
  provider: ProviderName,
  logger: Logger,
): void {
  const problems = findTemplateBindingProblems(provider);
  if (problems.length === 0) {
    logger.log(
      `Template registry: all ${Object.keys(WHATSAPP_TEMPLATES).length} templates bound for "${provider}"`,
    );
    return;
  }
  const detail = problems.map((p) => `  - ${p.key}: ${p.problem}`).join('\n');
  throw new Error(
    `WhatsApp template registry is not usable with WHATSAPP_PROVIDER="${provider}":\n${detail}`,
  );
}

export const whatsappProviderFactory: Provider = {
  provide: WHATSAPP_PROVIDER,
  useFactory: createWhatsappProvider,
  inject: [ConfigService, TwilioProvider],
};
