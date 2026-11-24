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

export function businessCvExpiringSubject(
  language: MailLanguage = 'fr',
): string {
  return language === 'en'
    ? 'Some CVs will be deleted soon'
    : 'Des CV vont bientôt être supprimés';
}

/** CVs of closed offers (or analyses) reach the end of their time in a month. */
export function businessCvExpiringEmail(
  name: string,
  items: { title: string; until: Date; url: string }[],
  language: MailLanguage = 'fr',
): string {
  const day = (d: Date) =>
    d.toLocaleDateString(language === 'en' ? 'en-GB' : 'fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Brazzaville',
    });
  const list = items
    .map(
      (i) =>
        `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.title)}</a> : ${
          language === 'en' ? 'from' : 'à partir du'
        } ${escapeHtml(day(i.until))}</li>`,
    )
    .join('');
  if (language === 'en') {
    return `
    <p>Hello${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      The CVs of these jobs reach the end of the time they are kept after
      closing. Their files, contact details and conversations will be deleted;
      scores and opinions stay.
    </p>
    <ul>${list}</ul>
    <p>Reopening a job keeps its CVs. Download the ones you still need.</p>
    ${emailButton(items[0].url, 'View these CVs')}
    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }
  return `
    <p>Bonjour${name ? ` ${escapeHtml(name)}` : ''},</p>
    <p>
      Les CV de ces offres arrivent au bout de leur durée de conservation
      après la clôture. Leurs fichiers, coordonnées et conversations seront
      supprimés ; les notes et les avis restent.
    </p>
    <ul>${list}</ul>
    <p>Rouvrir une offre garde ses CV. Téléchargez ceux dont vous avez encore besoin.</p>
    ${emailButton(items[0].url, 'Voir ces CV')}
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}
