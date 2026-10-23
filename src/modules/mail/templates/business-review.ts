import { escapeHtml } from './layout';

/**
 * The business review's decisions. By email, never WhatsApp: a business works
 * from the browser and its phone was never verified.
 */
export function businessApprovedEmail(
  name: string,
  businessName: string,
  dashboardUrl: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Bonne nouvelle : <strong>${escapeHtml(businessName)}</strong> est vérifiée.
      Votre compte entreprise Rabotka est désormais <strong>actif</strong>.
    </p>

    <p>
      Vous pouvez publier vos offres et consulter les profils présélectionnés
      depuis votre espace :
      <a href="${escapeHtml(dashboardUrl)}">${escapeHtml(dashboardUrl.replace(/^https?:\/\//, ''))}</a>
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}

export function businessRejectedEmail(
  name: string,
  businessName: string,
  reason?: string,
): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Après examen, nous n'avons pas pu valider les documents de
      <strong>${escapeHtml(businessName)}</strong>.
    </p>

    ${reasonBlock}

    <p>
      Répondez à cet email ou contactez notre équipe pour transmettre des pièces
      complémentaires : nous reprendrons la vérification dès leur réception.
    </p>

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
