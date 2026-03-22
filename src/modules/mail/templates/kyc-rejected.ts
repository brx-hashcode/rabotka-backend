import { escapeHtml, wrapEmailHtml } from './layout';

export function kycRejectedEmail(name: string, reason?: string): string {
  const reasonBlock = reason
    ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>`
    : '';

  const body = `
    <p>Hi ${escapeHtml(name)},</p>

    <p>
      After reviewing your application, we regret to inform you that your
      identity verification (KYC) has been <strong>rejected</strong>.
    </p>

   <p style="padding: 10px; background-color: #f0f0f0; border-radius: 5px;">${reasonBlock}</p>

    <p>
      If you believe this is an error or would like to submit a new application,
      please contact our support team.
    </p>

    <p>
      Thank you for your understanding,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
