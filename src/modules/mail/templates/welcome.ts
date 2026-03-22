import { escapeHtml, wrapEmailHtml } from './layout';

export function sendWelcomeEmail(name: string): string {
  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>Your profile has been successfully created!</p>

    <p>
      To activate your account, please complete your profile
      (photo and personal information).
    </p>

    <p>
      A Rabotka agent may also call you to verify your identity (KYC).
    </p>

    <p>
      If you have any questions, our team is here to help.
    </p>

    <p>
      Thank you for your trust,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
