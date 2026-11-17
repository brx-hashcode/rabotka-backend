import { emailButton, escapeHtml, type MailLanguage } from './layout';

/**
 * The business review's decisions. By email, never WhatsApp: a business works
 * from its dashboard and its phone was never verified. Sent with the layout's
 * « Business » label, signed by Rabotka Business.
 */
export function businessApprovedEmail(
  name: string,
  businessName: string,
  dashboardUrl: string,
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      Good news: <strong>${escapeHtml(businessName)}</strong> is verified.
      Your Rabotka Business account is now <strong>active</strong>.
    </p>

    <p>
      You can publish your jobs and find profiles from your workspace.
    </p>

    ${emailButton(dashboardUrl, 'Go to my workspace')}

    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Bonne nouvelle : <strong>${escapeHtml(businessName)}</strong> est vérifiée.
      Votre compte Rabotka Business est désormais <strong>actif</strong>.
    </p>

    <p>
      Vous pouvez publier vos offres et trouver des profils depuis votre
      espace.
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
  language: MailLanguage = 'fr',
): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      After review, we could not validate the file of
      <strong>${escapeHtml(businessName)}</strong>.
    </p>

    ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}

    <p>
      Correct your information or send new documents from your workspace, in
      the “My organisation” section: the verification resumes as soon as we
      receive them.
    </p>

    ${emailButton(organisationUrl, 'Correct my file')}

    <p>
      Thank you for your understanding,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }

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
  language: MailLanguage = 'fr',
): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      The document <strong>${escapeHtml(documentLabel)}</strong> sent for
      <strong>${escapeHtml(businessName)}</strong> was not accepted.
    </p>

    ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}

    <p>
      Send a new version from your workspace, in the “My organisation”
      section: it will be checked as soon as we receive it.
    </p>

    ${emailButton(organisationUrl, 'Replace the document')}

    <p>
      Thank you,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }

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

export function businessApprovedSubject(
  businessName: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `${businessName} is verified on Rabotka Business`
    : `${businessName} est vérifiée sur Rabotka Business`;
}

export function businessRejectedSubject(
  businessName: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `Verification of ${businessName}: file to correct`
    : `Vérification de ${businessName} : dossier à corriger`;
}

export function businessDocumentRejectedSubject(
  documentLabel: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `${documentLabel}: document to replace`
    : `${documentLabel} : document à remplacer`;
}
