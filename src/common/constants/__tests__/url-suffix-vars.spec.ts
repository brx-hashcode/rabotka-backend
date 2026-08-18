import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateName,
} from '../whatsapp-templates';

/**
 * A template that declares `urlSuffixVar` MUST emit that key from
 * `variables()`.
 *
 * Six of them did not — `kyc`, both `profileCreated*`, `unlockExpiredConversion`,
 * `offerExpiredApplicant`, `offerUnavailableWorker` — and every send failed with
 * Meta 131008, "Button at index 0 of type Url requires a parameter". Nothing
 * caught it: `withLoginCode` bails quietly at `if (!suffix) return variables`,
 * `buildComponents` then skips the button component because the value is
 * undefined, and `sendTemplateMessage` swallows the provider error into a
 * `false`. The failure was only visible once the delivery log existed.
 *
 * The declaration is the contract, so it is checked here rather than trusting a
 * reader to notice a missing key three lines below it.
 */

/**
 * Stands in for whatever shape each `variables()` destructures — a string, an
 * object, a number — so the registry can be walked without knowing the arity or
 * argument type of any individual entry.
 */
function permissiveArg(): unknown {
  return new Proxy(function () {} as unknown as object, {
    get: () => 'x',
    apply: () => 'x',
  });
}

const templatesWithUrlSuffix = (
  Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[]
).filter((key) => 'urlSuffixVar' in WHATSAPP_TEMPLATES[key]);

describe('urlSuffixVar contract', () => {
  it('covers a meaningful share of the registry', () => {
    // Guards the guard: if the filter above ever stops matching, the suite
    // below would pass vacuously.
    expect(templatesWithUrlSuffix.length).toBeGreaterThan(15);
  });

  it.each(templatesWithUrlSuffix)(
    '%s emits the variable its CTA button is filled from',
    (key) => {
      const template = WHATSAPP_TEMPLATES[key] as {
        urlSuffixVar: string;
        variables: (...args: unknown[]) => Record<string, string>;
      };
      const arg = permissiveArg();

      const emitted = template.variables(arg, arg, arg);

      expect(Object.keys(emitted)).toContain(template.urlSuffixVar);
    },
  );

  // Deliberately no assertion on the VALUE. For a `shortlink` template it is a
  // literal this file owns, but an `append` one passes through whatever the
  // caller supplies (`welcomePlatform` takes the path as its only argument), so
  // emptiness is not something the registry can promise. Presence of the key is
  // what was broken and what this file exists to hold.
});
