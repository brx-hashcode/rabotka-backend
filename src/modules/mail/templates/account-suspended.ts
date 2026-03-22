import { escapeHtml, wrapEmailHtml } from './layout';

export function accountSuspendedEmail(name: string): string {
  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>
      We are writing to let you know that your account has been <strong>suspended</strong>.
    </p>

    <p>
      If you believe this is an error or would like more information,
      please contact our support team.
    </p>

    <p>
      Regards,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
