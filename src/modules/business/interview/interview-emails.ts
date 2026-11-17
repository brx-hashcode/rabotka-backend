import { escapeHtml, type MailLanguage } from '../../mail/templates/layout';
import { writtenIn } from '../output-language';

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
  /** The reader's language (the job's); French unless said. */
  language?: MailLanguage;
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

/** The same moment, in the reader's language (en-GB for English). */
export function whenIn(d: Date, language: MailLanguage = 'fr'): string {
  if (language !== 'en') return frWhen(d);
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
  return `${day} at ${time}`;
}

export function modeLine(
  i: Pick<InterviewMail, 'mode' | 'location'>,
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') {
    if (i.mode === 'IN_PERSON')
      return i.location ? `In person, ${i.location}` : 'In person';
    if (i.mode === 'PHONE')
      return i.location
        ? `By phone (${i.location})`
        : 'By phone: the recruiter will call you';
    return i.location ? `Video call: ${i.location}` : 'Video call';
  }
  if (i.mode === 'IN_PERSON')
    return i.location ? `En personne, ${i.location}` : 'En personne';
  if (i.mode === 'PHONE')
    return i.location
      ? `Par téléphone (${i.location})`
      : 'Par téléphone : le recruteur vous appelle';
  return i.location ? `En visio : ${i.location}` : 'En visio';
}

function details(i: InterviewMail): string {
  const en = i.language === 'en';
  const link =
    i.mode === 'VIDEO' && i.location && /^https?:\/\//.test(i.location)
      ? `<a href="${escapeHtml(i.location)}">${escapeHtml(i.location)}</a>`
      : escapeHtml(
          modeLine(i, i.language).replace(
            en ? /^Video call: / : /^En visio : /,
            '',
          ),
        );
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;width:100%;border-radius:16px;background:#f3f5f7;">
      <tr><td style="padding:16px 20px;font-size:15px;line-height:1.6;">
        <strong>${escapeHtml(i.jobTitle)}</strong><br />
        ${escapeHtml(whenIn(i.startsAt, i.language))} · ${i.durationMinutes} min<br />
        ${i.mode === 'VIDEO' ? `${en ? 'Video call' : 'En visio'}${en ? ':' : ' :'} ${link}` : link}
      </td></tr>
    </table>`;
}

function note(message: string | null): string {
  return message?.trim()
    ? `<p style="white-space:pre-line;">${escapeHtml(message.trim())}</p>`
    : '';
}

const signed = (i: InterviewMail) =>
  i.language === 'en'
    ? `<p>Kind regards,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>`
    : `<p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>`;

const AGENDA_NOTE_FR =
  '<p style="color:#6b7280;font-size:13px;">Le fichier joint ajoute l’entretien à votre agenda.</p>';
const AGENDA_NOTE_EN =
  '<p style="color:#6b7280;font-size:13px;">The attached file adds the interview to your calendar.</p>';

export function interviewInviteEmail(
  i: InterviewMail,
  url: string,
  changed = false,
  /** Several times offered: the candidate picks one through the link. */
  options: Date[] = [],
): string {
  if (i.language === 'en') return inviteEnglish(i, url, changed, options);
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
    ${AGENDA_NOTE_FR}
    <p>Cordialement,<br /><strong>${escapeHtml(i.businessName)}</strong>, via Rabotka</p>
  `;
}

function inviteEnglish(
  i: InterviewMail,
  url: string,
  changed: boolean,
  options: Date[],
): string {
  if (options.length > 0) {
    const list = options
      .map(
        (d) => `<li style="margin:4px 0;">${escapeHtml(whenIn(d, 'en'))}</li>`,
      )
      .join('');
    return `
    <p>Hello ${escapeHtml(i.candidateName)},</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> ${changed ? 'is offering you new time slots' : 'is offering you an interview'}
      for the job “${escapeHtml(i.jobTitle)}” (${i.durationMinutes} min, ${escapeHtml(modeLine(i, 'en').replace(/: https?:\/\/\S+$/, ''))}).
      Choose the time that suits you:
    </p>
    <ul style="margin:12px 0;padding-left:20px;font-size:15px;">${list}</ul>
    ${note(i.message)}
    <p>
      <a href="${escapeHtml(url)}"><strong>Choose my time slot</strong></a>,
      or suggest another time if none suits you.
    </p>
    ${signed(i)}
  `;
  }
  return `
    <p>Hello ${escapeHtml(i.candidateName)},</p>
    <p>
      ${changed ? `<strong>${escapeHtml(i.businessName)}</strong> has changed your interview.` : `<strong>${escapeHtml(i.businessName)}</strong> is offering you an interview.`}
    </p>
    ${details(i)}
    ${note(i.message)}
    <p>
      Please confirm that you will attend, or suggest another time:
      <a href="${escapeHtml(url)}">reply to the invitation</a>.
    </p>
    ${AGENDA_NOTE_EN}
    ${signed(i)}
  `;
}

export function interviewCancelledEmail(i: InterviewMail): string {
  if (i.language === 'en') {
    return `
    <p>Hello ${escapeHtml(i.candidateName)},</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> has cancelled the interview
      planned for ${escapeHtml(whenIn(i.startsAt, 'en'))} for the job
      “${escapeHtml(i.jobTitle)}”.
    </p>
    ${signed(i)}
  `;
  }
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
  if (i.language === 'en') {
    return to === 'candidate'
      ? `
    <p>Hello ${escapeHtml(i.candidateName)},</p>
    <p>A quick reminder: your interview with <strong>${escapeHtml(i.businessName)}</strong> is tomorrow.</p>
    ${details(i)}
    ${signed(i)}`
      : `
    <p>Hello,</p>
    <p>Reminder: interview with <strong>${escapeHtml(i.candidateName)}</strong> tomorrow.</p>
    ${details(i)}
    <p>The Rabotka Business team</p>`;
  }
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

const ANSWER_SENTENCE_EN = {
  CONFIRMED: 'has confirmed they will attend',
  DECLINED: 'has declined the interview',
  RESCHEDULE_REQUESTED: 'is asking for another time',
} as const;

export function interviewAnsweredEmail(
  i: InterviewMail,
  answer: keyof typeof ANSWER_SENTENCE,
  responseNote: string | null,
): string {
  if (i.language === 'en') {
    return `
    <p>Hello,</p>
    <p><strong>${escapeHtml(i.candidateName)}</strong> ${ANSWER_SENTENCE_EN[answer]}.</p>
    ${details(i)}
    ${responseNote?.trim() ? `<p>Their message:</p>${note(responseNote)}` : ''}
    <p>The Rabotka Business team</p>
  `;
  }
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
  if (i.language === 'en') {
    return `
    <p>Hello ${escapeHtml(i.candidateName)},</p>
    <p>
      Noted: your interview with <strong>${escapeHtml(i.businessName)}</strong>
      is confirmed.
    </p>
    ${details(i)}
    ${note(i.message)}
    ${AGENDA_NOTE_EN}
    ${signed(i)}
  `;
  }
  return `
    <p>Bonjour ${escapeHtml(i.candidateName)},</p>
    <p>
      C’est noté : votre entretien avec <strong>${escapeHtml(i.businessName)}</strong>
      est confirmé.
    </p>
    ${details(i)}
    ${note(i.message)}
    ${AGENDA_NOTE_FR}
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
  if (i.language === 'en') {
    return `
    <p>Hello ${escapeHtml(guestName)},</p>
    <p>${escapeHtml(invitedBy)} invites you to join the video call interview with <strong>${escapeHtml(i.candidateName)}</strong>, for the following job.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;width:100%;border-radius:16px;background:#f3f5f7;">
      <tr><td style="padding:16px 20px;font-size:15px;line-height:1.6;">
        <strong>${escapeHtml(i.jobTitle)}</strong><br />
        ${escapeHtml(whenIn(i.startsAt, 'en'))} · ${i.durationMinutes} min
      </td></tr>
    </table>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#16a34a;color:#ffffff;font-weight:600;text-decoration:none;">Join the video call</a>
    </p>
    <p style="color:#6b7280;font-size:13px;">This link is personal: you join under your own name, without an account. It opens the day before the interview.</p>
    `;
  }
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

/**
 * The language an interview is written in: the job's (its description when
 * the interview still has its offer, else its title); French when nothing tells.
 */
export function interviewLanguage(i: {
  job_title: string;
  offer?: { description: string | null } | null;
}): MailLanguage {
  const description = i.offer?.description;
  return writtenIn(
    description ? `${i.job_title}\n${description}` : null,
    i.job_title,
  );
}

/** Subjects and preview texts of the candidate's interview e-mails. */
export const interviewSubject = {
  invite: (
    jobTitle: string,
    changed: boolean,
    language: MailLanguage = 'fr',
  ) =>
    language === 'en'
      ? `${changed ? 'Interview changed' : 'Interview invitation'} — ${jobTitle}`
      : `${changed ? 'Entretien modifié' : 'Invitation à un entretien'} — ${jobTitle}`,
  cancelled: (jobTitle: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Interview cancelled — ${jobTitle}`
      : `Entretien annulé — ${jobTitle}`,
  chosen: (jobTitle: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Interview confirmed — ${jobTitle}`
      : `Entretien confirmé — ${jobTitle}`,
  reminder: (jobTitle: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Reminder: interview tomorrow — ${jobTitle}`
      : `Rappel : entretien demain — ${jobTitle}`,
  guest: (jobTitle: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Video call interview — ${jobTitle}`
      : `Entretien en visio — ${jobTitle}`,
  guestPreview: (invitedBy: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `${invitedBy} invites you to a video call interview`
      : `${invitedBy} vous invite à un entretien en visio`,
  /** The calendar entry's title and description. */
  icsSummary: (
    jobTitle: string,
    businessName: string,
    language: MailLanguage = 'fr',
  ) =>
    language === 'en'
      ? `Interview — ${jobTitle} (${businessName})`
      : `Entretien — ${jobTitle} (${businessName})`,
  icsDescription: (businessName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Interview with ${businessName}.`
      : `Entretien avec ${businessName}.`,
};

const hm = (d: Date) =>
  d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
const dayOf = (d: Date) =>
  d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  });

/**
 * When an interview really took place, as the compte rendu tells it: « le
 * dimanche 15 novembre de 15:42 à 16:08 (prévu à 15:20) », from the moment the
 * business joined (or the first sentence) to « Terminer » (or the last one).
 * The planned time alone when nothing says otherwise.
 */
export function heldWhen(
  planned: Date,
  start: Date | null,
  end: Date | null,
): { when: string; minutes: number | null } {
  if (!start) return { when: frWhen(planned), minutes: null };
  const sameTime = Math.abs(start.getTime() - planned.getTime()) < 5 * 60_000;
  const plannedNote = sameTime
    ? ''
    : dayOf(planned) === dayOf(start)
      ? ` (prévu à ${hm(planned)})`
      : ` (prévu le ${frWhen(planned)})`;
  if (end && end.getTime() > start.getTime()) {
    const minutes = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / 60_000),
    );
    return {
      when: `${dayOf(start)} de ${hm(start)} à ${hm(end)}${plannedNote}`,
      minutes,
    };
  }
  return {
    when: `${dayOf(start)}, commencé à ${hm(start)}${plannedNote}`,
    minutes: null,
  };
}
