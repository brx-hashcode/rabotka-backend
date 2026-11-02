import { otpEmailPreview, otpEmailSubject, sendOtpEmail } from '../otp';

/**
 * Pentest A2-F17 (#873): the first name went into the OTP email raw, so a
 * profile could plant a link or markup in a Rabotka-branded email sent to an
 * address of its choosing.
 */
describe('sendOtpEmail', () => {
  it('escapes the first name', () => {
    const html = sendOtpEmail(
      '123456',
      '<a href="https://evil.example">Cliquez ici</a>',
    );

    expect(html).not.toContain('<a href=');
    expect(html).toContain('&lt;a href=');
  });

  it('greets plainly without a name', () => {
    expect(sendOtpEmail('123456')).toContain('Bonjour,');
  });
});

describe('sendOtpEmail purposes', () => {
  it('names Rabotka Business for a business sign-up and login', () => {
    for (const purpose of ['business-signup', 'business-login'] as const) {
      expect(otpEmailSubject(purpose)).toContain('Rabotka Business');
      expect(sendOtpEmail('123456', 'Awa', purpose)).toContain(
        "L'équipe Rabotka Business",
      );
    }
  });

  it('says the business sign-up code creates the organisation account', () => {
    expect(sendOtpEmail('123456', 'Awa', 'business-signup')).toContain(
      'créer le compte de votre organisation',
    );
  });

  it('keeps every subject distinct', () => {
    const purposes = [
      'business-signup',
      'business-login',
      'login',
      'admin',
      'agent',
    ] as const;
    expect(new Set(purposes.map(otpEmailSubject)).size).toBe(purposes.length);
  });

  it('puts the code in the preview text', () => {
    expect(otpEmailPreview('login', '654321')).toContain('654321');
  });

  it('never mentions WhatsApp', () => {
    expect(sendOtpEmail('123456', 'Awa', 'business-login')).not.toMatch(
      /whatsapp/i,
    );
  });
});
