import { escapeHtml, wrapEmailHtml } from './layout';

export function kycApprovedEmail(name: string): string {
  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>Great news! Your identity verification (KYC) has been <strong>successfully approved</strong>.</p>

    <p>
      To complete your account activation, you will receive a WhatsApp message
      containing a <strong>verification link</strong> to confirm that your phone number
      is connected to WhatsApp.
    </p>

    <p>
      Thank you for your trust,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
