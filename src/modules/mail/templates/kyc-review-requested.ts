import { emailButton, escapeHtml } from './layout';

/**
 * What is waiting for the reviewer: a person's identity documents (sent at
 * sign-up or later from the app), the same after a rejection, or an
 * organisation's papers.
 */
export type KycReviewKind = 'documents' | 'resubmitted' | 'organisation';

export function kycReviewSubject(kind: KycReviewKind, name: string): string {
  switch (kind) {
    case 'resubmitted':
      return `Rabotka – Nouveaux documents à vérifier : ${name}`;
    case 'organisation':
      return `Rabotka – Organisation à vérifier : ${name}`;
    default:
      return `Rabotka – Documents à vérifier : ${name}`;
  }
}

/**
 * Sent to each member of the KYC verification group when there is something
 * to review — no longer when a profile is merely created: a person may sign
 * up without their documents and send them later.
 */
export function kycReviewRequestedEmail(params: {
  reviewerFirstName: string | null;
  profileName: string;
  profileType: 'WORKER' | 'EMPLOYER';
  city: string | null;
  reviewUrl: string;
  kind?: KycReviewKind;
}): string {
  const kind = params.kind ?? 'documents';
  const type =
    kind === 'organisation'
      ? 'Organisation'
      : params.profileType === 'WORKER'
        ? 'Travailleur'
        : 'Employeur';
  const where = params.city ? ` · ${escapeHtml(params.city)}` : '';
  const intro =
    kind === 'resubmitted'
      ? "Un profil refusé vient d'envoyer de nouveaux documents d'identité :"
      : kind === 'organisation'
        ? 'Une organisation attend la vérification de ses documents :'
        : "Un profil vient d'envoyer ses documents d'identité et attend la vérification de son KYC :";
  const hello = params.reviewerFirstName?.trim()
    ? `Bonjour ${escapeHtml(params.reviewerFirstName.trim())},`
    : 'Bonjour,';

  return `
    <p>${hello}</p>

    <p>${intro}</p>

    <p>
      <strong>${escapeHtml(params.profileName)}</strong><br />
      ${type}${where}
    </p>

    ${emailButton(params.reviewUrl, 'Examiner le profil')}

    <p>
      Vous recevez cet e-mail parce que vous faites partie du groupe de
      vérification KYC.
    </p>

    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
