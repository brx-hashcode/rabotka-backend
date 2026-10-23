import { emailButton, escapeHtml } from './layout';

/**
 * The business review's decisions. By email, never WhatsApp: a business works
 * from its dashboard and its phone was never verified. Sent with the layout's
 * « Business » label, signed by Rabotka Business.
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
      Votre compte Rabotka Business est désormais <strong>actif</strong>.
    </p>

    <p>
      Vous pouvez publier vos offres et consulter les profils présélectionnés
      depuis votre espace.
    </p>

    ${emailButton(dashboardUrl, 'Accéder à mon espace')}

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
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
      Après examen, nous n'avons pas pu valider le dossier de
      <strong>${escapeHtml(businessName)}</strong>.
    </p>

    ${reasonBlock}

    <p>
      Corrigez vos informations ou envoyez de nouveaux documents depuis votre
      espace, rubrique « Mon organisation » : la vérification reprendra dès
      leur réception.
    </p>

    ${emailButton(organisationUrl, 'Corriger mon dossier')}

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka Business</strong>
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
      « Mon organisation » : elle sera vérifiée dès réception.
    </p>

    ${emailButton(organisationUrl, 'Remplacer le document')}

    <p>
      Merci,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}
