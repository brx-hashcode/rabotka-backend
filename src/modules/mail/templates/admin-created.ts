import { escapeHtml, wrapEmailHtml } from './layout';

export function adminCreatedEmail(name: string): string {
  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>Your administrator account has been successfully created on the Rabotka platform.</p>

    <p>
      You can now sign in to the administration panel using your email address.
    </p>

    <p>
      If you did not initiate this account creation or have any questions,
      please contact your super administrator.
    </p>

    <p>
      Welcome to the team,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body, {
    previewText: 'Your Rabotka administrator account has been created.',
  });
}
