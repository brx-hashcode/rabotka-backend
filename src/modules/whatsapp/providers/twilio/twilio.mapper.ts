import { toE164 } from '../../contracts/address';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';
import type { TemplateKey, TemplateParams } from '../../contracts';

/**
 * Twilio addresses a WhatsApp endpoint as `whatsapp:+242069917686` — the
 * channel prefix is part of the address, on both `to` and `from`.
 */
export function toProviderAddress(raw: string): string {
  return `whatsapp:${toE164(raw)}`;
}

/**
 * Resolve a logical template key to the Content SID actually sent.
 *
 * SIDs are env-overridable through `sid()` in the registry, so this reads the
 * resolved value rather than any hardcoded default.
 */
export function toContentSid(key: TemplateKey): string {
  return WHATSAPP_TEMPLATES[key].contentSid;
}

/**
 * Build Twilio's `contentVariables` map for a template.
 *
 * The registry's `variables()` already produces the `{'1': …, '9': …}` shape
 * Twilio wants, so this is a thin, type-safe call through to it — the value of
 * having it here is that call sites pass a `TemplateKey` and never see the
 * numbered map.
 */
export function toContentVariables<K extends TemplateKey>(
  key: K,
  params: TemplateParams<K>,
): Record<string, string> {
  const build = WHATSAPP_TEMPLATES[key].variables as (
    p: TemplateParams<K>,
  ) => Record<string, string>;
  return build(params);
}
