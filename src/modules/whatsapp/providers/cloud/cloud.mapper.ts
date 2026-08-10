import { toDigits } from '../../contracts/address';
import {
  getButtonUrlVar,
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
 * parameters positionally, not by name) and the button variable, naming the one
 * value that fills a CTA button's URL rather than the body.
 *
 * Routing keys off `getButtonUrlVar`, NOT `urlSuffixVar`. The latter also means
 * "inject a login code here", so a public-page button like
 * `viewWorkerPortfolio` leaves it unset — and keying off it put that template's
 * slug in the body with no button parameter at all.
 *
 * Order matters: Meta matches body parameters positionally, so a transposition
 * here delivers successfully with the values in the wrong slots. See
 * `orderedKeys` for why that is safe by default and still sorted explicitly.
 */
export function buildComponents(
  key: WhatsAppTemplateName,
  variables: Record<string, string>,
): CloudTemplateComponent[] {
  const buttonVar = getButtonUrlVar(key);
  const components: CloudTemplateComponent[] = [];

  // An AUTHENTICATION template is a fixed shape Meta owns: one body parameter
  // holding the code, and the SAME code again as the copy-code button's
  // parameter. Sending only the body is a parameter-count mismatch, so this
  // cannot go through the generic path below.
  if (WHATSAPP_TEMPLATES[key].category === 'AUTHENTICATION') {
    const code = variables[orderedKeys(variables)[0]] ?? '';
    return [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      },
    ];
  }

  const bodyKeys = orderedKeys(variables).filter((k) => k !== buttonVar);
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
  if (buttonVar && variables[buttonVar] !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: variables[buttonVar] }],
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
