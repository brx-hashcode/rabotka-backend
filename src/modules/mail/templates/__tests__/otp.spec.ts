import { sendOtpEmail } from '../otp';

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
