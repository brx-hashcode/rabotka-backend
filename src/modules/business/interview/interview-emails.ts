import { emailButton, escapeHtml } from '../../mail/templates/layout';

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
): string {
  return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      ${changed ? `<strong>${escapeHtml(i.businessName)}</strong> a modifié votre entretien.` : `<strong>${escapeHtml(i.businessName)}</strong> vous propose un entretien.`}
    </p>
    ${details(i)}
    ${note(i.message)}
    <p>Merci de confirmer votre présence, ou de proposer un autre moment :</p>
    ${emailButton(url, 'Répondre à l’invitation')}
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
  url: string,
  to: 'candidate' | 'business',
): string {
  return to === 'candidate'
    ? `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>Petit rappel : votre entretien avec <strong>${escapeHtml(i.businessName)}</strong> a lieu demain.</p>
    ${details(i)}
    ${url ? emailButton(url, 'Voir l’invitation') : ''}
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>`
    : `
    <p>Bonjour,</p>
    <p>Rappel : entretien avec <strong>${escapeHtml(i.candidateName)}</strong> demain.</p>
    ${details(i)}
    ${emailButton(url, 'Voir mes entretiens')}
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
  url: string,
): string {
  return `
    <p>Bonjour,</p>
    <p><strong>${escapeHtml(i.candidateName)}</strong> ${ANSWER_SENTENCE[answer]}.</p>
    ${details(i)}
    ${responseNote?.trim() ? `<p>Son message :</p>${note(responseNote)}` : ''}
    ${emailButton(url, 'Voir mes entretiens')}
    <p>L’équipe Rabotka Business</p>
  `;
}

export { ANSWER_SENTENCE };
