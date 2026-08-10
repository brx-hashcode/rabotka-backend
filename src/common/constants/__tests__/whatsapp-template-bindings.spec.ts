import {
  WHATSAPP_TEMPLATES,
  findBindingProblemsIn,
  findTemplateBindingProblems,
  getTemplateKeyBySid,
  getUrlSuffixTargetByKey,
  isTemplateKey,
  templateCloudName,
  templateLanguage,
  type TemplateBinding,
  type WhatsAppTemplateName,
} from '../whatsapp-templates';

const KEYS = Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[];

describe('template registry bindings', () => {
  it('binds every template for both providers', () => {
    expect(findTemplateBindingProblems('twilio')).toEqual([]);
    expect(findTemplateBindingProblems('cloud')).toEqual([]);
  });

  it('gives every template a category', () => {
    for (const key of KEYS) {
      expect(['UTILITY', 'AUTHENTICATION', 'MARKETING']).toContain(
        WHATSAPP_TEMPLATES[key].category,
      );
    }
  });

  it('sends the OTP as AUTHENTICATION', () => {
    // Meta prices and rate-limits authentication separately, and will reject an
    // OTP body submitted as UTILITY.
    expect(WHATSAPP_TEMPLATES.otp.category).toBe('AUTHENTICATION');
  });

  it('defaults every template to French', () => {
    for (const key of KEYS) {
      expect(templateLanguage(key)).toBe('fr');
    }
  });

  it('gives every template a distinct Cloud name', () => {
    const names = KEYS.map(templateCloudName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names Cloud templates in the snake_case Meta requires', () => {
    // Meta rejects a template name with uppercase or hyphens outright, so a
    // typo here is a send that fails only in production.
    for (const key of KEYS) {
      expect(templateCloudName(key)).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('gives every template a distinct content SID', () => {
    const sids = KEYS.map((k) => WHATSAPP_TEMPLATES[k].contentSid);
    expect(new Set(sids).size).toBe(sids.length);
  });
});

describe('findBindingProblemsIn', () => {
  // A blank env override cannot get here — sid() and cloudName() both fall back
  // to their default — so the empty case only arises from a registry entry
  // added by hand without a value. What an override CAN do is set a wrong
  // value, and with two providers in play the easy mistake is pasting a Meta
  // template name into a Twilio SID override, or the reverse.
  const binding = (over: Partial<TemplateBinding> = {}): TemplateBinding => ({
    contentSid: 'HXab1c58ea985695fc3eb473aef762b137',
    category: 'UTILITY',
    cloud: { name: 'rabotka_kyc_approved' },
    ...over,
  });

  it('accepts a well-formed binding on both providers', () => {
    expect(findBindingProblemsIn({ kyc: binding() }, 'twilio')).toEqual([]);
    expect(findBindingProblemsIn({ kyc: binding() }, 'cloud')).toEqual([]);
  });

  it('reports an empty content SID on twilio', () => {
    expect(
      findBindingProblemsIn({ kyc: binding({ contentSid: '   ' }) }, 'twilio'),
    ).toEqual([{ key: 'kyc', problem: 'contentSid is empty' }]);
  });

  it('reports a Meta name pasted into the Twilio SID override', () => {
    expect(
      findBindingProblemsIn(
        { kyc: binding({ contentSid: 'rabotka_kyc_approved' }) },
        'twilio',
      ),
    ).toEqual([
      {
        key: 'kyc',
        problem:
          'contentSid "rabotka_kyc_approved" is not a Twilio Content SID',
      },
    ]);
  });

  it('reports an empty Cloud name on cloud', () => {
    expect(
      findBindingProblemsIn(
        { kyc: binding({ cloud: { name: ' ' } }) },
        'cloud',
      ),
    ).toEqual([{ key: 'kyc', problem: 'cloud.name is empty' }]);
  });

  it('reports a Twilio SID pasted into the Cloud name override', () => {
    expect(
      findBindingProblemsIn(
        {
          kyc: binding({
            cloud: { name: 'HXab1c58ea985695fc3eb473aef762b137' },
          }),
        },
        'cloud',
      ),
    ).toEqual([
      {
        key: 'kyc',
        problem:
          'cloud.name "HXab1c58ea985695fc3eb473aef762b137" is not a valid Meta template name',
      },
    ]);
  });

  it('does not fail a twilio boot for a broken Cloud binding', () => {
    // The whole point of checking only the active provider: the Cloud rollout
    // must not gate deploys that are still running on Twilio.
    expect(
      findBindingProblemsIn(
        { kyc: binding({ cloud: { name: '' } }) },
        'twilio',
      ),
    ).toEqual([]);
  });

  it('does not fail a cloud boot for a broken Twilio binding', () => {
    expect(
      findBindingProblemsIn({ kyc: binding({ contentSid: '' }) }, 'cloud'),
    ).toEqual([]);
  });
});

describe('key lookups', () => {
  it('round-trips every key through its SID', () => {
    for (const key of KEYS) {
      expect(getTemplateKeyBySid(WHATSAPP_TEMPLATES[key].contentSid)).toBe(key);
    }
  });

  it('returns undefined for a SID that is not ours', () => {
    expect(
      getTemplateKeyBySid('HXdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).toBeUndefined();
  });

  it('narrows a string to a key', () => {
    expect(isTemplateKey('kyc')).toBe(true);
    expect(isTemplateKey('nope')).toBe(false);
    expect(isTemplateKey('toString')).toBe(false);
  });

  it('resolves the URL-suffix target by key, matching the SID lookup', () => {
    // The login-code injection used to be keyed on the SID; keying it on the
    // key has to select exactly the same target or every CTA button regresses.
    expect(getUrlSuffixTargetByKey('reminder24h')).toEqual({
      variable: '9',
      separator: '&',
      mode: 'append',
    });
    expect(getUrlSuffixTargetByKey('kycPendingMenu')).toEqual({
      variable: '1',
      separator: '?',
      mode: 'shortlink',
    });
    expect(getUrlSuffixTargetByKey('otp')).toBeUndefined();
  });
});
