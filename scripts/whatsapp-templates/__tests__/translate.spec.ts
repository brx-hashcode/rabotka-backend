import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate } from '../translate';
import { urlAction, variablesIn, type SourceTemplate } from '../twilio-source';
import { AUTHORED_KEYS, authoredTemplates } from '../definitions';
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
/**
 * Only the templates Twilio still owns.
 *
 * The two unlock templates were re-authored against Meta directly (see
 * `definitions.ts`) — emoji-free, and with a FLOW button that Twilio Content
 * cannot express at all. Their Twilio fixtures are the OLD versions, so every
 * assertion below would be checking the registry against copy the app no
 * longer sends.
 */
const sources: SourceTemplate[] = available
  ? (
      JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as Omit<
        SourceTemplate,
        'spec'
      >[]
    )
      .filter((s) => !AUTHORED_KEYS.has(s.key))
      .map((s) => ({ ...s, spec: s.content.types[s.kind] }))
  : [];

const describeIfCaptured = available ? describe : describe.skip;

describeIfCaptured('registry vs the live Twilio templates', () => {
  it('captured every template Twilio still owns', () => {
    expect(sources).toHaveLength(
      Object.keys(WHATSAPP_TEMPLATES).length - AUTHORED_KEYS.size,
    );
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

/**
 * The repo-authored templates. No fixtures involved — these have no Twilio
 * counterpart to capture, which is the whole reason they live in
 * `definitions.ts`.
 */
describe('authored templates', () => {
  const FLOW_ID = 'FLOW_ID_FOR_TEST';
  const authored = () => {
    process.env.WHATSAPP_FEEDBACK_FLOW_ID = FLOW_ID;
    return authoredTemplates();
  };

  it('covers exactly the keys it claims', () => {
    expect(new Set(Object.keys(authored()))).toEqual(new Set(AUTHORED_KEYS));
  });

  // The Flow button is a property of the two contact-unlock templates, not of
  // being authored here: `kycRejected` and `accountSuspended` are authored too
  // and deliberately carry no button at all, because neither audience can
  // follow a link (not ACTIVE / refused a session).
  const FLOW_BUTTON_KEYS = [
    'contactUnlocked',
    'contactUnlockedRecommendation',
  ] as const;
  // v2 of both gained a URL button. v1 had none, on the reasoning that these
  // profiles can never hold a session — no longer true, so the CTA is the
  // point of the version bump and is worth pinning.
  const URL_BUTTON_KEYS = ['kycRejected', 'accountSuspended'] as const;
  // Deliberately button-less: this one carries whatever an admin typed, so
  // there is no single destination a CTA could point at.
  const NO_BUTTON_KEYS = ['adminMessage'] as const;

  it.each(NO_BUTTON_KEYS)('%s carries no button at all', (key) => {
    expect(
      authored()[key]?.components.find((c) => c.type === 'BUTTONS'),
    ).toBeUndefined();
  });

  it.each(URL_BUTTON_KEYS)('%s carries a URL button, not a Flow', (key) => {
    const buttons = authored()[key]?.components.find(
      (c) => c.type === 'BUTTONS',
    );
    expect(buttons?.buttons).toHaveLength(1);
    expect(buttons?.buttons?.[0].type).toBe('URL');
    // WhatsApp allows one variable in a button URL and it must END it — the
    // outbound path swaps that variable for a one-tap login code.
    expect(buttons?.buttons?.[0].url).toMatch(/\{\{1\}\}$/);
  });

  it('accounts for every authored key', () => {
    // Stops a new authored template from silently having neither assertion.
    expect(
      new Set([...FLOW_BUTTON_KEYS, ...URL_BUTTON_KEYS, ...NO_BUTTON_KEYS]),
    ).toEqual(new Set(AUTHORED_KEYS));
  });

  it.each(FLOW_BUTTON_KEYS)(
    '%s carries the feedback Flow on its button, not a link',
    (key) => {
      const buttons = authored()[key]?.components.find(
        (c) => c.type === 'BUTTONS',
      );
      expect(buttons?.buttons).toHaveLength(1);
      expect(buttons?.buttons?.[0]).toEqual({
        type: 'FLOW',
        text: 'Laisser un avis',
        flow_id: FLOW_ID,
        navigate_screen: 'FEEDBACK',
        flow_action: 'navigate',
      });
      // A link button here would be the old `/leave-note` web form, which is
      // what the Flow replaced.
      expect(buttons?.buttons?.[0].url).toBeUndefined();
    },
  );

  it.each([...AUTHORED_KEYS])('%s has an emoji-free body', (key) => {
    const text = authored()[key]?.components.find(
      (c) => c.type === 'BODY',
    )?.text;
    expect(text).toBeTruthy();
    // `Extended_Pictographic` rather than a hand-rolled range: it is the
    // property Unicode defines for exactly this, and the previous bodies used
    // characters from four different blocks (🎉 📞 ✉️ 🤝).
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each([...AUTHORED_KEYS])(
    '%s names itself what the registry sends to',
    (key) => {
      // Same 132001 trap the Twilio-sourced templates have a check for: the
      // registry name is what a send resolves to, and nothing in the type
      // system ties it to the name the template is approved under.
      expect(authored()[key]?.name).toBe(templateCloudName(key));
    },
  );

  it.each([...AUTHORED_KEYS])(
    '%s numbers its body variables contiguously from 1',
    (key) => {
      const body = authored()[key]?.components.find((c) => c.type === 'BODY');
      const vars = variablesIn(body?.text);
      expect(vars).toEqual(vars.map((_, i) => String(i + 1)));
      // Meta matches examples to variables positionally.
      expect(body?.example?.body_text?.[0]).toHaveLength(vars.length);
    },
  );

  it('throws rather than submitting a template bound to no Flow', () => {
    delete process.env.WHATSAPP_FEEDBACK_FLOW_ID;
    // A FLOW button binds its flow at creation. Submitted with an empty id it
    // would be rejected, and rejections count against the WABA quality rating.
    expect(() => authoredTemplates()).toThrow(/WHATSAPP_FEEDBACK_FLOW_ID/);
  });
});
