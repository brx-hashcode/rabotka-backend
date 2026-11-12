import { escapeHtml } from '../../mail/templates/layout';

/**
 * Interview e-mails: to the candidate (invitation, change, cancellation,
 * reminder) and to the business (the candidate's answer, the reminder).
 * The candidate's e-mails are signed by the business, sent through Rabotka.
 */

export type InterviewMail = {
  businessName: string;
  jobTitle: string;
  candidateName: string;
  startsAt: Date;
  durationMinutes: number;
  mode: 'IN_PERSON' | 'PHONE' | 'VIDEO';
  location: string | null;
  message: string | null;
};

const TZ = 'Africa/Brazzaville';

export function frWhen(d: Date): string {
  const day = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  });
  const time = d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
  return `${day} à ${time}`;
}

export function modeLine(i: Pick<InterviewMail, 'mode' | 'location'>): string {
  if (i.mode === 'IN_PERSON')
    return i.location ? `En personne, ${i.location}` : 'En personne';
  if (i.mode === 'PHONE')
    return i.location
      ? `Par téléphone (${i.location})`
      : 'Par téléphone : le recruteur vous appelle';
  return i.location ? `En visio : ${i.location}` : 'En visio';
}

function details(i: InterviewMail): string {
  const link =
    i.mode === 'VIDEO' && i.location && /^https?:\/\//.test(i.location)
      ? `<a href="${escapeHtml(i.location)}">${escapeHtml(i.location)}</a>`
      : escapeHtml(modeLine(i).replace(/^En visio : /, ''));
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;width:100%;border-radius:16px;background:#f3f5f7;">
      <tr><td style="padding:16px 20px;font-size:15px;line-height:1.6;">
        <strong>${escapeHtml(i.jobTitle)}</strong><br />
        ${escapeHtml(frWhen(i.startsAt))} · ${i.durationMinutes} min<br />
        ${i.mode === 'VIDEO' ? `En visio : ${link}` : link}
      </td></tr>
    </table>`;
}

function note(message: string | null): string {
  return message?.trim()
    ? `<p style="white-space:pre-line;">${escapeHtml(message.trim())}</p>`
    : '';
}

export function interviewInviteEmail(
  i: InterviewMail,
  url: string,
  changed = false,
  /** Several times offered: the candidate picks one through the link. */
  options: Date[] = [],
): string {
  if (options.length > 0) {
    const list = options
      .map((d) => `<li style="margin:4px 0;">${escapeHtml(frWhen(d))}</li>`)
      .join('');
    return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> ${changed ? 'vous propose de nouveaux créneaux' : 'vous propose un entretien'}
      pour le poste « ${escapeHtml(i.jobTitle)} » (${i.durationMinutes} min, ${escapeHtml(modeLine(i).replace(/ : https?:\/\/\S+$/, ''))}).
      Choisissez le moment qui vous convient :
    </p>
    <ul style="margin:12px 0;padding-left:20px;font-size:15px;">${list}</ul>
    ${note(i.message)}
    <p>
      <a href="${escapeHtml(url)}"><strong>Choisir mon créneau</strong></a>,
      ou proposer un autre moment si aucun ne vous convient.
    </p>
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>
  `;
  }
  return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      ${changed ? `<strong>${escapeHtml(i.businessName)}</strong> a modifié votre entretien.` : `<strong>${escapeHtml(i.businessName)}</strong> vous propose un entretien.`}
    </p>
    ${details(i)}
    ${note(i.message)}
    <p>
      Merci de confirmer votre présence, ou de proposer un autre moment :
      <a href="${escapeHtml(url)}">répondre à l’invitation</a>.
    </p>
    <p style="color:#6b7280;font-size:13px;">Le fichier joint ajoute l’entretien à votre agenda.</p>
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>
  `;
}

export function interviewCancelledEmail(i: InterviewMail): string {
  return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> a annulé l’entretien prévu
      le ${escapeHtml(frWhen(i.startsAt))} pour le poste
      « ${escapeHtml(i.jobTitle)} ».
    </p>
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>
  `;
}

export function interviewReminderEmail(
  i: InterviewMail,
  to: 'candidate' | 'business',
): string {
  return to === 'candidate'
    ? `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>Petit rappel : votre entretien avec <strong>${escapeHtml(i.businessName)}</strong> a lieu demain.</p>
    ${details(i)}
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>`
    : `
    <p>Bonjour,</p>
    <p>Rappel : entretien avec <strong>${escapeHtml(i.candidateName)}</strong> demain.</p>
    ${details(i)}
    <p>L’équipe Rabotka Business</p>`;
}

const ANSWER_SENTENCE = {
  CONFIRMED: 'a confirmé sa présence',
  DECLINED: 'a décliné l’entretien',
  RESCHEDULE_REQUESTED: 'demande un autre moment',
} as const;

export function interviewAnsweredEmail(
  i: InterviewMail,
  answer: keyof typeof ANSWER_SENTENCE,
  responseNote: string | null,
): string {
  return `
    <p>Bonjour,</p>
    <p><strong>${escapeHtml(i.candidateName)}</strong> ${ANSWER_SENTENCE[answer]}.</p>
    ${details(i)}
    ${responseNote?.trim() ? `<p>Son message :</p>${note(responseNote)}` : ''}
    <p>L’équipe Rabotka Business</p>
  `;
}

export { ANSWER_SENTENCE };

/** To the candidate once they chose one of the times offered: the settled interview. */
export function interviewChosenEmail(i: InterviewMail): string {
  return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      C’est noté : votre entretien avec <strong>${escapeHtml(i.businessName)}</strong>
      est confirmé.
    </p>
    ${details(i)}
    ${note(i.message)}
    <p style="color:#6b7280;font-size:13px;">Le fichier joint ajoute l’entretien à votre agenda.</p>
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>
  `;
}

/** To someone the business invited into the call: their own link, no account. */
export function interviewGuestEmail(
  i: InterviewMail,
  guestName: string,
  url: string,
  invitedBy: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(guestName)},</p>
    <p>${escapeHtml(invitedBy)} vous invite à rejoindre l’entretien en visio avec <strong>${escapeHtml(i.candidateName)}</strong>, pour le poste suivant.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;width:100%;border-radius:16px;background:#f3f5f7;">
      <tr><td style="padding:16px 20px;font-size:15px;line-height:1.6;">
        <strong>${escapeHtml(i.jobTitle)}</strong><br />
        ${escapeHtml(frWhen(i.startsAt))} · ${i.durationMinutes} min
      </td></tr>
    </table>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#16a34a;color:#ffffff;font-weight:600;text-decoration:none;">Rejoindre la visio</a>
    </p>
    <p style="color:#6b7280;font-size:13px;">Ce lien est personnel : vous entrez sous votre nom, sans compte. Il s’ouvre la veille de l’entretien.</p>
    `;
}
