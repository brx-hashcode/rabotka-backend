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

/** No one decided here: the offer ended with this application still open. */
export function applicationClosedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      L'offre <strong>${escapeHtml(jobTitle)}</strong> de
      ${escapeHtml(businessName)} est maintenant fermée. Votre candidature
      n'a donc pas pu aboutir.
    </p>
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

/** A retention taken back: the candidate is back among those considered. */
export function applicationRetainCancelledEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      ${escapeHtml(businessName)} revient sur sa décision pour
      <strong>${escapeHtml(jobTitle)}</strong> : votre candidature n'est plus
      retenue pour le moment, mais elle reste à l'étude.
    </p>
    <p>Le recruteur vous recontacte s'il donne suite.</p>
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

/**
 * A business writes to someone who applied on its careers page (« Envoyer
 * un message »): its words as they are, and how to answer it.
 */
export function businessMessageEmail(args: {
  firstName: string;
  businessName: string;
  jobTitle: string;
  body: string;
  /** Where the candidate answers: the member who wrote, or the business. */
  replyTo: string | null;
}): string {
  const paragraphs = escapeHtml(args.body)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
  return `
    <p>Bonjour ${escapeHtml(args.firstName)},</p>
    <p>
      ${escapeHtml(args.businessName)} vous écrit à propos de votre candidature pour
      <strong>${escapeHtml(args.jobTitle)}</strong> :
    </p>
    <div style="margin:20px 0;padding:16px 20px;border-radius:12px;background:#f1f4f8;">${paragraphs}</div>
    ${
      args.replyTo
        ? `${emailButton(`mailto:${args.replyTo}`, `Répondre à ${args.businessName}`)}
    <p style="color:#6b7570;font-size:14px;">Ou écrivez à ${escapeHtml(args.replyTo)}.</p>`
        : ''
    }
  `;
}
