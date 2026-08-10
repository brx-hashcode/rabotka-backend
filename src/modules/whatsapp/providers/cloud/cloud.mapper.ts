import { toDigits } from '../../contracts/address';
import {
  getUrlSuffixTargetByKey,
  templateCloudName,
  templateLanguage,
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateName,
} from '../../../../common/constants/whatsapp-templates';
import type { TemplateKey, TemplateParams } from '../../contracts';
import {
  MESSAGING_PRODUCT,
  type CloudTemplateComponent,
  type CloudTemplatePayload,
} from './cloud.types';

/**
 * Cloud addresses a recipient as bare digits — no `+`, no `whatsapp:` prefix.
 * Sending `+242…` is accepted by the API and then silently fails to deliver,
 * which is the worst possible failure mode, so this is not optional politeness.
 */
export function toProviderAddress(raw: string): string {
  return toDigits(raw);
}

/**
 * The numbered keys of a variable map, in numeric order.
 *
 * Defensive, not load-bearing: JavaScript already enumerates integer-like keys
 * in ascending numeric order regardless of insertion order, so `{'3','1','2'}`
 * already yields `['1','2','3']`. The explicit sort states the requirement
 * rather than depending on that, and keeps the behaviour if a non-integer key
 * ever appears — which would otherwise sort by insertion and silently
 * transpose the body parameters Meta matches positionally.
 */
function orderedKeys(variables: Record<string, string>): string[] {
  return Object.keys(variables).sort((a, b) => Number(a) - Number(b));
}

/**
 * Turn the registry's `{'1': …, '9': …}` map into Graph components.
 *
 * Derived rather than declared per template. The registry already encodes the
 * two facts needed: the numbered map (whose ORDER matters — Meta matches body
 * parameters positionally, not by name) and `urlSuffixVar`, naming the one
 * variable that fills a CTA button's URL rather than the body.
 *
 * Order matters: Meta matches body parameters positionally, so a transposition
 * here delivers successfully with the values in the wrong slots. See
 * `orderedKeys` for why that is safe by default and still sorted explicitly.
 */
export function buildComponents(
  key: WhatsAppTemplateName,
  variables: Record<string, string>,
): CloudTemplateComponent[] {
  const target = getUrlSuffixTargetByKey(key);
  const components: CloudTemplateComponent[] = [];

  const bodyKeys = orderedKeys(variables).filter((k) => k !== target?.variable);
  if (bodyKeys.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyKeys.map((k) => ({
        type: 'text' as const,
        text: variables[k],
      })),
    });
  }

  // Meta indexes buttons by position within the approved template. Every CTA in
  // this registry is a single-button card, so index 0 is the only one there is;
  // a template with several buttons would need the index declared alongside
  // `urlSuffixVar`.
  if (target && variables[target.variable] !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: variables[target.variable] }],
    });
  }

  return components;
}

/** Build the wire payload for a template send from already-resolved variables. */
export function toTemplatePayload(
  to: string,
  key: WhatsAppTemplateName,
  variables: Record<string, string>,
  opts?: { languageOverride?: string; internalMessageId?: string },
): CloudTemplatePayload {
  const components = buildComponents(key, variables);
  return {
    messaging_product: MESSAGING_PRODUCT,
    recipient_type: 'individual',
    to: toProviderAddress(to),
    type: 'template',
    template: {
      name: templateCloudName(key),
      language: { code: opts?.languageOverride ?? templateLanguage(key) },
      ...(components.length > 0 ? { components } : {}),
    },
    ...(opts?.internalMessageId
      ? { biz_opaque_callback_data: opts.internalMessageId }
      : {}),
  };
}

/** Resolve typed params to the numbered map, then to the wire payload. */
export function toTemplatePayloadFromParams<K extends TemplateKey>(
  to: string,
  key: K,
  params: TemplateParams<K>,
  opts?: { languageOverride?: string; internalMessageId?: string },
): CloudTemplatePayload {
  const build = WHATSAPP_TEMPLATES[key].variables as (
    p: TemplateParams<K>,
  ) => Record<string, string>;
  return toTemplatePayload(to, key, build(params), opts);
}
