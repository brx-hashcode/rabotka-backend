import { emailButton, escapeHtml } from './layout';

/** Emails around an application from a business's public careers page. */
export function applicationReceivedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      Votre candidature pour <strong>${escapeHtml(jobTitle)}</strong> a bien
      été envoyée à <strong>${escapeHtml(businessName)}</strong>.
    </p>
    <p>Le recruteur revient vers vous directement si votre profil est retenu.</p>
  `;
}

export function applicationRefusedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
  message: string | null,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      ${escapeHtml(businessName)} a étudié votre candidature pour
      <strong>${escapeHtml(jobTitle)}</strong> et ne donne pas suite.
    </p>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    <p>Merci de votre intérêt, et bonne continuation.</p>
  `;
}

export function applicationRetainedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      Bonne nouvelle : ${escapeHtml(businessName)} a retenu votre candidature
      pour <strong>${escapeHtml(jobTitle)}</strong>.
    </p>
    <p>Le recruteur vous contacte directement pour la suite.</p>
  `;
}

export function newExternalApplicationEmail(
  candidateName: string,
  jobTitle: string,
  url: string,
): string {
  return `
    <p>Bonjour,</p>
    <p>
      <strong>${escapeHtml(candidateName)}</strong> a postulé à votre offre
      <strong>${escapeHtml(jobTitle)}</strong> depuis votre page carrières.
    </p>
    ${emailButton(url, 'Voir la candidature')}
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}
