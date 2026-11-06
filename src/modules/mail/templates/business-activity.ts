import { emailButton, escapeHtml } from './layout';

/**
 * What happens in a business's space while nobody is looking at it: a new
 * Rabotka applicant, a new message. A business is never reached on WhatsApp,
 * so these e-mails (and the in-app feed) are how it hears of them. Paced by
 * the sender: one per offer, or per conversation, for a while.
 */

export function businessNewApplicationEmail(
  name: string,
  workerName: string,
  jobTitle: string,
  url: string,
): string {
  return `
    <p>Bonjour${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      <strong>${escapeHtml(workerName)}</strong> a postulé à votre offre
      <strong>${escapeHtml(jobTitle)}</strong> sur Rabotka.
    </p>
    <p>Retrouvez sur l'offre tous ses candidats, classés du plus adapté au moins adapté.</p>
    ${emailButton(url, 'Voir les candidats')}
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}

export function businessNewMessageEmail(
  name: string,
  senderName: string,
  jobTitle: string | null,
  url: string,
): string {
  return `
    <p>Bonjour${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      <strong>${escapeHtml(senderName)}</strong> vous a écrit${
        jobTitle ? ` au sujet de <strong>${escapeHtml(jobTitle)}</strong>` : ''
      }.
    </p>
    ${emailButton(url, 'Lire le message')}
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}
