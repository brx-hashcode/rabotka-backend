import { escapeHtml, wrapEmailHtml } from './layout';

export function paymentSuccessEmail(
  name: string,
  description: string,
  amount: number,
): string {
  const body = `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>

    <p>
      Votre paiement a été <strong>traité avec succès</strong>.
    </p>

    <table style="border-collapse:collapse; width:100%; margin: 16px 0;">
      <tr>
        <td style="padding: 8px 12px; background:#f5f5f5; font-weight:bold;">Objet</td>
        <td style="padding: 8px 12px;">${escapeHtml(description)}</td>
      </tr>
      <tr>
        <td style="padding: 8px 12px; background:#f5f5f5; font-weight:bold;">Montant</td>
        <td style="padding: 8px 12px;">${amount.toLocaleString('fr-FR')} FCFA</td>
      </tr>
    </table>

    <p>
      Merci pour votre paiement. Vous pouvez désormais fermer la page de paiement.
    </p>

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
