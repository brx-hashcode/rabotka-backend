import { toE164 } from '../../contracts/address';
import {
  WHATSAPP_TEMPLATES,
  templateContentSid,
} from '../../../../common/constants/whatsapp-templates';
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
 *
 * Throws for a Cloud-only template. Those have no Twilio counterpart at all, so
 * reaching here means a deployment still on Twilio is trying to send one — a
 * configuration mistake, and one worth failing loudly: returning undefined
 * would send a message with no content and report success.
 */
export function toContentSid(key: TemplateKey): string {
  const contentSid = templateContentSid(key);
  if (!contentSid) {
    throw new Error(
      `WhatsApp template "${key}" is Cloud-only and has no Twilio Content SID. ` +
        'Set WHATSAPP_PROVIDER=cloud, or stop sending it from this deployment.',
    );
  }
  return contentSid;
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
