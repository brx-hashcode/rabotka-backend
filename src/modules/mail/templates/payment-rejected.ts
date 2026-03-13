import { escapeHtml, wrapEmailHtml } from './layout';

export function paymentRejectedEmail(reason?: string): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  const body = `
    <p>
      Nous avons examiné votre demande de paiement et nous avons le regret de vous informer
      qu'elle a été <strong>rejetée</strong>.
    </p>

    ${reasonBlock}

    <p>
      Si vous pensez qu'il s'agit d'une erreur ou souhaitez soumettre une nouvelle demande,
      veuillez contacter notre équipe support ou réessayer via l'application.
    </p>

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
