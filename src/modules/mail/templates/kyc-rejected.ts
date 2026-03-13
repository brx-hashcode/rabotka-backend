import { escapeHtml, wrapEmailHtml } from './layout';

export function kycRejectedEmail(name: string, reason?: string): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Après examen de votre dossier, nous avons le regret de vous informer que votre
      vérification d'identité (KYC) a été <strong>rejetée</strong>.
    </p>

    ${reasonBlock}

    <p>
      Si vous pensez qu'il s'agit d'une erreur ou souhaitez soumettre un nouveau dossier,
      veuillez contacter notre équipe support.
    </p>

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
