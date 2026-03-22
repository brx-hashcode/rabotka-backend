import { escapeHtml, wrapEmailHtml } from './layout';

export function sendOtpEmail(code: string, supportEmail: string): string {
  const body = `
    <p>Hi,</p>

    <p>
      Use this one-time password to sign in to Rabotka: ${escapeHtml(code)}
    </p>

    <p>
      If you didn't request for a one-time password, your account may have been compromised
      and you should take a few steps to make sure your account is secure.
    </p>

    <p>
      Regards,<br />
      <strong>Rabotka Team</strong>
    </p>

    <p>Email: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Use this one-time password to sign in to Rabotka: ${code}`,
  });
}
