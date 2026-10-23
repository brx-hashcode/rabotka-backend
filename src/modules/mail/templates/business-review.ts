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
  reason: string | undefined,
  organisationUrl: string,
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
      Corrigez vos informations ou envoyez de nouveaux documents depuis votre
      espace : nous reprendrons la vérification dès leur réception.
      <br />
      <a href="${escapeHtml(organisationUrl)}">${escapeHtml(organisationUrl.replace(/^https?:\/\//, ''))}</a>
    </p>

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}

/** One paper refused on its own: the business replaces it from its space. */
export function businessDocumentRejectedEmail(
  name: string,
  businessName: string,
  documentLabel: string,
  reason: string | undefined,
  organisationUrl: string,
): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Le document <strong>${escapeHtml(documentLabel)}</strong> envoyé pour
      <strong>${escapeHtml(businessName)}</strong> n'a pas été accepté.
    </p>

    ${reasonBlock}

    <p>
      Envoyez-en une nouvelle version depuis votre espace, rubrique
      Organisation :
      <a href="${escapeHtml(organisationUrl)}">${escapeHtml(organisationUrl.replace(/^https?:\/\//, ''))}</a>
    </p>

    <p>
      Merci,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
