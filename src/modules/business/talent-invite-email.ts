import type { EmploymentType } from '@prisma/client';
import { businessSiteUrl, signOff } from '../mail/audience';
import {
  emailButton,
  escapeHtml,
  type MailLanguage,
} from '../mail/templates/layout';
import { whenIn } from './interview/interview-emails';

export type TalentInviteMail = {
  firstName: string | null;
  businessName: string;
  /** The business's careers page; null only for a row older than slugs. */
  businessSlug: string | null;
  jobTitle: string;
  reference: string;
  employmentType: EmploymentType;
  city: string | null;
  countryName: string | null;
  isRemote: boolean;
  scheduledAt: Date | null;
  /** The reader's language (the offer's); French unless said. */
  language?: MailLanguage;
};

const TYPE: Record<EmploymentType, string> = {
  MISSION: 'Mission',
  CDD: 'CDD',
  CDI: 'CDI',
  STAGE: 'Stage',
};

/**
 * The offer on the business's careers page, where anybody can apply without
 * an account — tagged so its applications count as « Invitation ».
 */
export function talentInviteUrl(i: TalentInviteMail): string | null {
  if (!i.businessSlug) return null;
  return `${businessSiteUrl()}/carrieres/${encodeURIComponent(i.businessSlug)}/${encodeURIComponent(i.reference)}?source=invitation`;
}

const TYPE_EN: Record<EmploymentType, string> = {
  MISSION: 'Mission',
  CDD: 'Fixed-term contract',
  CDI: 'Permanent contract',
  STAGE: 'Internship',
};

const TZ = 'Africa/Brazzaville';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A mission may start 4 h after it is published: within a day is urgent. */
export function isUrgentMission(
  i: TalentInviteMail,
  now = new Date(),
): boolean {
  if (i.employmentType !== 'MISSION' || !i.scheduledAt) return false;
  const left = i.scheduledAt.getTime() - now.getTime();
  return left > 0 && left <= DAY_MS;
}

export function talentInviteSubject(
  i: TalentInviteMail,
  now = new Date(),
): string {
  if (i.language === 'en') {
    const urgent = isUrgentMission(i, now) ? 'Urgent: ' : '';
    return `${urgent}${i.businessName} invites you to apply — ${i.jobTitle}`;
  }
  const urgent = isUrgentMission(i, now) ? 'Urgent : ' : '';
  return `${urgent}${i.businessName} vous invite à postuler — ${i.jobTitle}`;
}

/** YYYY-MM-DD in Brazzaville, to tell « aujourd'hui » and « demain ». */
const dayOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

function time(d: Date, language: MailLanguage = 'fr'): string {
  return d.toLocaleTimeString(language === 'en' ? 'en-GB' : 'fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

/**
 * When it starts, said so it never contradicts itself. A mission starts at an
 * hour — often the same day, since it may be published 4 h ahead — so it gets
 * the time, and « aujourd'hui » / « demain » when that close. A contract's
 * start is a day. A start already past is not « à partir du » anything: a
 * mission says it has begun, a contract says nothing.
 */
export function startLine(
  i: TalentInviteMail,
  now = new Date(),
): string | null {
  const at = i.scheduledAt;
  if (!at) return null;
  const past = at.getTime() <= now.getTime();
  if (i.language === 'en') {
    if (i.employmentType !== 'MISSION') {
      return past ? null : `From ${frDate(at, 'en')}`;
    }
    if (past) return `Started on ${whenIn(at, 'en')}`;
    if (dayOf(at) === dayOf(now)) return `Starts today at ${time(at, 'en')}`;
    if (dayOf(at) === dayOf(new Date(now.getTime() + DAY_MS))) {
      return `Starts tomorrow at ${time(at, 'en')}`;
    }
    return `Starts on ${whenIn(at, 'en')}`;
  }
  if (i.employmentType !== 'MISSION') {
    return past ? null : `À partir du ${frDate(at)}`;
  }
  if (past) return `Commencée le ${whenIn(at)}`;
  if (dayOf(at) === dayOf(now)) return `Commence aujourd’hui à ${time(at)}`;
  if (dayOf(at) === dayOf(new Date(now.getTime() + DAY_MS))) {
    return `Commence demain à ${time(at)}`;
  }
  return `Commence le ${whenIn(at)}`;
}

function place(i: TalentInviteMail): string | null {
  if (i.isRemote) return i.language === 'en' ? 'Remote' : 'À distance';
  return [i.city, i.countryName].filter((x) => x?.trim()).join(', ') || null;
}

function frDate(date: Date, language: MailLanguage = 'fr'): string {
  return date.toLocaleDateString(language === 'en' ? 'en-GB' : 'fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

/** What identifies the offer even without the link: its reference above all. */
function details(i: TalentInviteMail, now: Date): string {
  const en = i.language === 'en';
  const start = startLine(i, now);
  const lines = [
    `<strong>${escapeHtml(i.jobTitle)}</strong>`,
    `${en ? 'Reference: ' : 'Référence : '}<strong>${escapeHtml(i.reference)}</strong>`,
    escapeHtml((en ? TYPE_EN : TYPE)[i.employmentType] ?? i.employmentType),
    place(i) && escapeHtml(place(i)!),
    start && escapeHtml(start),
  ].filter(Boolean);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;width:100%;border-radius:16px;background:#f3f5f7;">
      <tr><td style="padding:16px 20px;font-size:15px;line-height:1.6;">
        ${lines.join('<br />')}
      </td></tr>
    </table>`;
}

/**
 * « Inviter à postuler », by e-mail: the same message as the in-app
 * notification (JOB_INVITATION), with the offer's details and a button to
 * its careers page. To a worker, so it signs as Rabotka.
 */
export function talentInviteEmail(
  i: TalentInviteMail,
  now = new Date(),
): string {
  if (i.language === 'en') return english(i, now);
  const hello = i.firstName?.trim()
    ? `Bonjour ${escapeHtml(i.firstName.trim())},`
    : 'Bonjour,';
  const url = talentInviteUrl(i);
  return `
    <p>${hello}</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> vous invite à postuler à
      cette offre :
    </p>
    ${details(i, now)}
    ${
      isUrgentMission(i, now)
        ? '<p><strong>Mission urgente :</strong> elle commence bientôt, répondez dès que possible.</p>'
        : ''
    }
    ${
      url
        ? `<p>Consultez l’offre et postulez en quelques minutes :</p>
    ${emailButton(url, 'Voir l’offre et postuler')}`
        : `<p>Retrouvez-la sur Rabotka avec sa référence, ou dans vos notifications.</p>`
    }
    <p>Cordialement,<br />${signOff('worker')}</p>
  `;
}

function english(i: TalentInviteMail, now: Date): string {
  const hello = i.firstName?.trim()
    ? `Hello ${escapeHtml(i.firstName.trim())},`
    : 'Hello,';
  const url = talentInviteUrl(i);
  return `
    <p>${hello}</p>
    <p>
      <strong>${escapeHtml(i.businessName)}</strong> invites you to apply for
      this job:
    </p>
    ${details(i, now)}
    ${
      isUrgentMission(i, now)
        ? '<p><strong>Urgent mission:</strong> it starts soon, please reply as soon as possible.</p>'
        : ''
    }
    ${
      url
        ? `<p>View the job and apply in a few minutes:</p>
    ${emailButton(url, 'View the job and apply')}`
        : `<p>Find it on Rabotka with its reference, or in your notifications.</p>`
    }
    <p>Kind regards,<br />The Rabotka team</p>
  `;
}
