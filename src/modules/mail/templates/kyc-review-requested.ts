import { emailButton, escapeHtml } from './layout';

/**
 * Sent to each member of the KYC verification group when a profile is
 * created: every profile arrives with its identity documents, so a new
 * profile is a KYC waiting for review.
 */
export function kycReviewRequestedEmail(params: {
  reviewerFirstName: string;
  profileName: string;
  profileType: 'WORKER' | 'EMPLOYER';
  city: string | null;
  reviewUrl: string;
}): string {
  const type = params.profileType === 'WORKER' ? 'Travailleur' : 'Employeur';
  const where = params.city ? ` · ${escapeHtml(params.city)}` : '';

  return `
    <p>Bonjour ${escapeHtml(params.reviewerFirstName)},</p>

    <p>Un nouveau profil vient d'être créé et attend la vérification de son KYC :</p>

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
