import { toDigits } from '../../contracts/address';
import { coverImageUrl } from '../../../../common/constants/whatsapp-carousel';
import { sanitizeTemplateVariable } from '../../../../common/utils/whatsapp-template-text.util';
import {
  getButtonUrlVar,
  getFlowTokenVar,
  hasImageHeader,
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
 * rather than depending on that.
 *
 * Non-numeric keys are dropped rather than sorted. `Number('flow_token')` is
 * NaN and a comparator returning NaN is read as 0, so a single reserved key
 * would not merely place itself wrongly — it would stop the surrounding
 * integer keys from ordering against each other, and Meta matches body
 * parameters POSITIONALLY. Reserved keys (`flow_token`) address components of
 * their own and are read by name below.
 */
function orderedKeys(variables: Record<string, string>): string[] {
  return Object.keys(variables)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
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
 *
 * Every `text` parameter is run through `sanitizeTemplateVariable` on the way
 * out. That guard belongs HERE rather than at the ~15 call sites: a variable
 * carries free text more often than not (an admin's rejection reason, a worker's
 * own profile description), Meta rejects the whole send with 132018 over a
 * single newline inside one of them, and this is the one function every Cloud
 * template send passes through — typed params via `toTemplatePayloadFromParams`
 * and the raw numbered map the outbound processor hands over after rewriting the
 * login code alike. A free-text variable added to the registry tomorrow is
 * covered without anyone remembering to cover it.
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
    const code = sanitizeTemplateVariable(
      variables[orderedKeys(variables)[0]] ?? '',
    );
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

  // Meta keeps only an EXAMPLE image on the approved template and wants the
  // real one on every send. Twilio bakes it in and takes nothing, which is why
  // no caller passes an image and why this has to come from the registry.
  if (hasImageHeader(key)) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: coverImageUrl() } }],
    });
  }

  const bodyKeys = orderedKeys(variables).filter((k) => k !== buttonVar);
  if (bodyKeys.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyKeys.map((k) => ({
        type: 'text' as const,
        text: sanitizeTemplateVariable(variables[k]),
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
      parameters: [
        { type: 'text', text: sanitizeTemplateVariable(variables[buttonVar]) },
      ],
    });
  }

  // A FLOW button — the native in-chat feedback form, opened from an approved
  // template rather than sent as a free-form interactive message. That is the
  // whole point of putting it here: `sendFeedbackFlow` only reaches people
  // inside WhatsApp's 24h service window, and someone who paid on the web
  // never opened one.
  //
  // Deliberately NOT sanitized. `flow_token` is an opaque round-trip token on an
  // `action` parameter, not display text: it is not what 132018 polices, and
  // rewriting it would break the correlation on the way back.
  const flowTokenVar = getFlowTokenVar(key);
  if (flowTokenVar && variables[flowTokenVar]) {
    components.push({
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [
        { type: 'action', action: { flow_token: variables[flowTokenVar] } },
      ],
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
