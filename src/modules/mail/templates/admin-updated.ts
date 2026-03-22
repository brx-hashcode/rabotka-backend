import { escapeHtml, wrapEmailHtml } from './layout';

export function adminUpdatedEmail(name: string): string {
  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>Your administrator account information has been updated.</p>

    <p>
      If you did not make this change or believe it was made in error,
      please contact your super administrator immediately.
    </p>

    <p>
      Regards,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body, {
    previewText: 'Your account information has been updated.',
  });
}
