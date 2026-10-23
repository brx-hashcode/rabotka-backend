import { escapeHtml } from './layout';
import { signOff, type EmailAudience } from '../audience';

export function paymentSuccessEmail(
  name: string,
  description: string,
  amount: number,
  audience: EmailAudience = 'worker',
): string {
  return `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>

    <p>
      Nous vous confirmons que votre paiement a été
      <strong>effectué avec succès</strong>.
    </p>

    <p>
      Voici le récapitulatif de votre transaction :
    </p>

    <table style="border-collapse: collapse; width: 100%; margin: 16px 0; border: 1px solid #e5e5e5;">
      <tr>
        <td style="padding: 10px 12px; background:#f8f9fa; font-weight:bold;">
          Description
        </td>
        <td style="padding: 10px 12px;">
          ${escapeHtml(description)}
        </td>
      </tr>
      <tr>
        <td style="padding: 10px 12px; background:#f8f9fa; font-weight:bold;">
          Montant payé
        </td>
        <td style="padding: 10px 12px;">
          ${amount.toLocaleString('fr-FR')} FCFA
        </td>
      </tr>
    </table>

    <p>
      Merci pour votre confiance. Cette confirmation sert de preuve de paiement
      et peut être conservée pour vos références.
    </p>

    <p>
      Si vous avez des questions ou besoin d'assistance, notre équipe reste à votre disposition.
    </p>

    <p>
      Cordialement,<br />
      <strong>${signOff(audience)}</strong>
    </p>
  `;
}

/** Sent with the invoice PDF attached, after a confirmed payment. */
export function invoiceEmail(
  name: string,
  description: string,
  amount: number,
  audience: EmailAudience = 'worker',
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Veuillez trouver ci-joint votre facture pour
      <strong>${escapeHtml(description)}</strong>, d'un montant de
      <strong>${amount.toLocaleString('fr-FR')} FCFA</strong>.
    </p>

    <p>
      Conservez-la pour vos références. Elle reste aussi disponible
      ${audience === 'business' ? 'dans votre espace' : "dans l'application"}.
    </p>

    <p>
      Cordialement,<br />
      <strong>${signOff(audience)}</strong>
    </p>
  `;
}
