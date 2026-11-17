import { emailButton, escapeHtml, type MailLanguage } from './layout';

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
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      <strong>${escapeHtml(workerName)}</strong> applied to your job
      <strong>${escapeHtml(jobTitle)}</strong> on Rabotka.
    </p>
    <p>Find all its candidates on the job, ranked from most to least suited.</p>
    ${emailButton(url, 'View the candidates')}
    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }
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
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      <strong>${escapeHtml(senderName)}</strong> wrote to you${
        jobTitle ? ` about <strong>${escapeHtml(jobTitle)}</strong>` : ''
      }.
    </p>
    ${emailButton(url, 'Read the message')}
    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }
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

export function businessNewApplicationSubject(
  jobTitle: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `New application: ${jobTitle}`
    : `Nouvelle candidature : ${jobTitle}`;
}

export function businessNewMessageSubject(
  senderName: string,
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? `New message from ${senderName}`
    : `Nouveau message de ${senderName}`;
}
