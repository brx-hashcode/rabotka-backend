import { writtenIn } from '../../business/output-language';
import { emailButton, escapeHtml, type MailLanguage } from './layout';

/**
 * The language a candidate is written to in: the job's, from its title and
 * description (French when nothing tells).
 */
export function offerLanguage(offer: {
  title: string;
  description?: string | null;
}): MailLanguage {
  return writtenIn(
    offer.description ? `${offer.title}\n${offer.description}` : null,
    offer.title,
  );
}

/** Emails around an application from a business's public careers page. */
export function applicationReceivedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
  /** They agreed to be kept for other posts: until when, and how to take it back. */
  pool: { until: Date; withdrawUrl: string } | null = null,
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    const untilEn = pool?.until.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Brazzaville',
    });
    return `
    <p>Hello ${escapeHtml(firstName)},</p>
    <p>
      Your application for <strong>${escapeHtml(jobTitle)}</strong> has been
      sent to <strong>${escapeHtml(businessName)}</strong>.
    </p>
    <p>The recruiter will get back to you directly if your profile is hired.</p>
    ${
      pool
        ? `<p style="color:#6b7570;font-size:14px;">
      As you agreed, ${escapeHtml(businessName)} keeps your application
      until ${escapeHtml(untilEn ?? '')} to offer you other jobs.
      <a href="${escapeHtml(pool.withdrawUrl)}">Remove my application from its list</a>.
    </p>`
        : ''
    }
  `;
  }
  const until = pool?.until.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      Votre candidature pour <strong>${escapeHtml(jobTitle)}</strong> a bien
      été envoyée à <strong>${escapeHtml(businessName)}</strong>.
    </p>
    <p>Le recruteur revient vers vous directement si votre profil est retenu.</p>
    ${
      pool
        ? `<p style="color:#6b7570;font-size:14px;">
      Comme vous l’avez accepté, ${escapeHtml(businessName)} garde votre candidature
      jusqu’au ${escapeHtml(until ?? '')} pour vous proposer d’autres postes.
      <a href="${escapeHtml(pool.withdrawUrl)}">Retirer ma candidature de sa liste</a>.
    </p>`
        : ''
    }
  `;
}

export function applicationRefusedEmail(
  firstName: string,
  businessName: string,
  jobTitle: string,
  message: string | null,
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(firstName)},</p>
    <p>
      ${escapeHtml(businessName)} has reviewed your application for
      <strong>${escapeHtml(jobTitle)}</strong> and will not take it further.
    </p>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    <p>Thank you for your interest, and all the best.</p>
  `;
  }
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
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(firstName)},</p>
    <p>
      The job <strong>${escapeHtml(jobTitle)}</strong> at
      ${escapeHtml(businessName)} is now closed. Your application could
      therefore not go through.
    </p>
    <p>Thank you for your interest, and all the best.</p>
  `;
  }
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
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(firstName)},</p>
    <p>
      Good news: ${escapeHtml(businessName)} has hired you for
      <strong>${escapeHtml(jobTitle)}</strong>.
    </p>
    <p>The recruiter will contact you directly for the next steps.</p>
  `;
  }
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
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello ${escapeHtml(firstName)},</p>
    <p>
      ${escapeHtml(businessName)} is reversing its decision for
      <strong>${escapeHtml(jobTitle)}</strong>: you are no longer hired for
      now, but your application is still under review.
    </p>
    <p>The recruiter will contact you again if it goes ahead.</p>
  `;
  }
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
  /** The reader's (a member of the team), not the job's. */
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    return `
    <p>Hello,</p>
    <p>
      <strong>${escapeHtml(candidateName)}</strong> applied to your job
      <strong>${escapeHtml(jobTitle)}</strong> from your careers page.
    </p>
    ${emailButton(url, 'See the application')}
    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>
  `;
  }
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
  language?: MailLanguage;
}): string {
  const paragraphs = escapeHtml(args.body)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
  if (args.language === 'en') {
    return `
    <p>Hello ${escapeHtml(args.firstName)},</p>
    <p>
      ${escapeHtml(args.businessName)} is writing to you about your application for
      <strong>${escapeHtml(args.jobTitle)}</strong>:
    </p>
    <div style="margin:20px 0;padding:16px 20px;border-radius:12px;background:#f1f4f8;">${paragraphs}</div>
    ${
      args.replyTo
        ? `${emailButton(`mailto:${args.replyTo}`, `Reply to ${args.businessName}`)}
    <p style="color:#6b7570;font-size:14px;">Or write to ${escapeHtml(args.replyTo)}.</p>`
        : ''
    }
  `;
  }
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

/**
 * A business invites someone it kept (a careers-page candidate who agreed,
 * or a CV it analysed) to apply to another of its offers.
 */
export function poolInviteEmail(args: {
  firstName: string;
  businessName: string;
  jobTitle: string;
  url: string;
  language?: MailLanguage;
}): string {
  if (args.language === 'en') {
    return `
    <p>Hello ${escapeHtml(args.firstName)},</p>
    <p>
      ${escapeHtml(args.businessName)} thought of you for its job
      <strong>${escapeHtml(args.jobTitle)}</strong> and invites you to apply.
    </p>
    ${emailButton(args.url, 'View the job and apply')}
    <p style="color:#6b7570;font-size:14px;">Applying only takes a few minutes, without creating an account.</p>
  `;
  }
  return `
    <p>Bonjour ${escapeHtml(args.firstName)},</p>
    <p>
      ${escapeHtml(args.businessName)} a pensé à vous pour son offre
      <strong>${escapeHtml(args.jobTitle)}</strong> et vous invite à postuler.
    </p>
    ${emailButton(args.url, 'Voir l’offre et postuler')}
    <p style="color:#6b7570;font-size:14px;">Postuler ne prend que quelques minutes, sans créer de compte.</p>
  `;
}

/** Subjects and preview texts of the e-mails to a careers-page applicant. */
export const externalApplicationSubject = {
  received: (businessName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Application sent to ${businessName}`
      : `Candidature envoyée à ${businessName}`,
  /** Retained, retention cancelled, refused, closed. */
  update: (businessName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Your application at ${businessName}`
      : `Votre candidature chez ${businessName}`,
  poolInvite: (
    businessName: string,
    jobTitle: string,
    language: MailLanguage = 'fr',
  ) =>
    language === 'en'
      ? `${businessName} invites you to apply · ${jobTitle}`
      : `${businessName} vous invite à postuler · ${jobTitle}`,
  poolInvitePreview: (jobTitle: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `A job for you: ${jobTitle}`
      : `Une offre pour vous : ${jobTitle}`,
};
