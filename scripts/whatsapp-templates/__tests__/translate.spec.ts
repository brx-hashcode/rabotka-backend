import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate } from '../translate';
import { urlAction, variablesIn, type SourceTemplate } from '../twilio-source';
import {
  WHATSAPP_TEMPLATES,
  getButtonUrlVar,
  templateCloudName,
  type WhatsAppTemplateName,
} from '../../../src/common/constants/whatsapp-templates';

/**
 * Runs against fixtures captured from the live Twilio Content API by
 * `generate.ts`, so it needs no credentials and no network but still checks the
 * real definitions rather than a mock that can drift from them.
 *
 * Regenerate with:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts
 */
const FIXTURES = path.join(
  'scripts',
  'whatsapp-templates',
  'out',
  'fixtures.json',
);

const available = fs.existsSync(FIXTURES);
const sources: SourceTemplate[] = available
  ? (
      JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as Omit<
        SourceTemplate,
        'spec'
      >[]
    ).map((s) => ({ ...s, spec: s.content.types[s.kind] }))
  : [];

const describeIfCaptured = available ? describe : describe.skip;

describeIfCaptured('registry vs the live Twilio templates', () => {
  it('captured all 27', () => {
    expect(sources).toHaveLength(Object.keys(WHATSAPP_TEMPLATES).length);
  });

  /**
   * THE CHECK THAT WOULD HAVE CAUGHT THE viewWorkerPortfolio BUG.
   *
   * Twilio shares one {{n}} namespace across body and button, so a variable
   * that belongs in the button is invisible there. Meta splits them, and
   * sending a button value in the body is a parameter-count mismatch that
   * arrives as a rejected send, not a compile error.
   */
  it.each(sources.map((s) => [s.key, s] as const))(
    '%s declares the button variable Twilio actually uses',
    (_key, source) => {
      const action = urlAction(source.spec);
      const urlVars = variablesIn(action?.url);
      const declared = getButtonUrlVar(source.key);

      if (urlVars.length === 0) {
        // No variable in the URL means nothing should be routed to the button.
        expect(declared).toBeUndefined();
        return;
      }
      expect(urlVars).toHaveLength(1);
      expect(declared).toBe(urlVars[0]);
    },
  );

  it.each(sources.map((s) => [s.key, s] as const))(
    '%s has body variables numbered contiguously from 1',
    (_key, source) => {
      // The translation keeps body text verbatim and only renumbers the button
      // variable to {{1}}. That is only correct while body variables are
      // already 1..n — a gap would silently shift every parameter after it.
      const text = source.spec.body ?? source.spec.title ?? '';
      const declared = getButtonUrlVar(source.key);
      const bodyVars = variablesIn(text).filter((v) => v !== declared);
      expect(bodyVars).toEqual(bodyVars.map((_, i) => String(i + 1)));
    },
  );

  it.each(sources.map((s) => [s.key, s] as const))(
    '%s translates without issues',
    (_key, source) => {
      // Cards legitimately report a missing media handle until upload-media.ts
      // has run; nothing else should have anything to say.
      const { issues } = translate(source, { mediaHandle: 'FAKE_HANDLE' });
      expect(issues).toEqual([]);
    },
  );
});

describeIfCaptured('translated payloads', () => {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const payloadFor = (key: string) =>
    translate(byKey.get(key as WhatsAppTemplateName)!, {
      mediaHandle: 'FAKE_HANDLE',
    }).payload;

  it('renumbers the button URL variable to {{1}}', () => {
    // reminder24h's body uses {{1}}..{{8}} and Twilio puts the button at {{9}}.
    // Meta gives the button its own namespace starting at 1.
    const p = payloadFor('reminder24h');
    const buttons = p.components.find((c) => c.type === 'BUTTONS');
    expect(buttons?.buttons?.[0].url).toContain('{{1}}');
    expect(buttons?.buttons?.[0].url).not.toContain('{{9}}');

    const body = p.components.find((c) => c.type === 'BODY');
    expect(body?.text).toContain('{{8}}');
    expect(body?.example?.body_text?.[0]).toHaveLength(8);
  });

  it('moves a card title into the BODY, because WhatsApp renders no card body', () => {
    const p = payloadFor('kycPendingMenu');
    expect(p.components.map((c) => c.type)).toEqual([
      'HEADER',
      'BODY',
      'BUTTONS',
    ]);
    expect(p.components.find((c) => c.type === 'BODY')?.text).toContain(
      'vérification',
    );
    expect(
      p.components.find((c) => c.type === 'HEADER')?.example?.header_handle,
    ).toEqual(['FAKE_HANDLE']);
  });

  it('gives the AUTHENTICATION template no body text of its own', () => {
    // Meta generates that copy from the locale and rejects a custom body.
    const p = payloadFor('otp');
    expect(p.category).toBe('AUTHENTICATION');
    const body = p.components.find((c) => c.type === 'BODY');
    expect(body?.text).toBeUndefined();
    expect(body?.add_security_recommendation).toBe(true);
    expect(
      p.components.find((c) => c.type === 'BUTTONS')?.buttons?.[0],
    ).toMatchObject({ type: 'OTP', otp_type: 'COPY_CODE' });
  });

  it('uses realistic examples taken from Twilio, not placeholders', () => {
    // Meta reviewers reject templates whose examples read as filler.
    const body = payloadFor('statusCheck').components.find(
      (c) => c.type === 'BODY',
    );
    expect(body?.example?.body_text?.[0][0]).toBe('Ménage bureau');
  });

  it('names every template after its Twilio friendly_name', () => {
    for (const s of sources) {
      expect(payloadFor(s.key).name).toBe(s.content.friendly_name);
    }
  });

  it("matches the registry's cloud.name for every template", () => {
    // The one that would have caught the 132001 in production. The registry's
    // defaults started as guesses derived from the key; 16 of 27 were wrong,
    // and the first real OTP send failed with "template name (rabotka_otp)
    // does not exist in fr". Nothing in the type system connects the name the
    // app sends to the name the template was approved under — only this does.
    for (const s of sources) {
      expect(templateCloudName(s.key)).toBe(s.content.friendly_name);
    }
  });

  it('emits only names Meta accepts', () => {
    for (const s of sources) {
      expect(payloadFor(s.key).name).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
