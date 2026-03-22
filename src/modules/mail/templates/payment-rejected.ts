import { escapeHtml, wrapEmailHtml } from './layout';

export function paymentRejectedEmail(reason?: string): string {
  const reasonBlock = reason
    ? `
  <p style="padding: 10px; background-color: #f0f0f0; border-radius: 5px;">${escapeHtml(reason)}</p>`
    : '';

  const body = `
    <p>
      We have reviewed your payment request and regret to inform you
      that it has been <strong>rejected</strong>.
    </p>

   ${reasonBlock}

    <p>
      If you believe this is an error or would like to submit a new request,
      please contact our support team or try again through the app.
    </p>

    <p>
      Thank you for your understanding,<br />
      <strong>Rabotka Team</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
