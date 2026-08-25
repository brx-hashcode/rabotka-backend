import { emailButton, escapeHtml } from './layout';

export type ReferralRewardedEmailOptions = {
  /** First name of the filleul whose payment triggered the credit. */
  refereeName: string;
  /** What this recipient received, in FCFA. */
  creditedAmount: number;
  /** Where the CTA points. Not a one-tap link — those are minted for WhatsApp. */
  appUrl: string;
};

export const REFERRAL_REWARDED_EMAIL_PREVIEW =
  'Votre parrainage vous a rapporté un crédit.';

/**
 * Sent to the parrain when a filleul's first mobile-money payment settles the
 * parrainage.
 *
 * Email, not WhatsApp, is the channel that works here. A parrain who shared
 * their code weeks ago is almost certainly outside the 24-hour service window,
 * so a free-form WhatsApp message would be rejected with 63016 and vanish
 * silently — see `WhatsAppService.isServiceWindowOpen`. The approved template
 * that fixes that is a separate, Meta-gated piece of work; this email carries
 * the news in the meantime and stays useful afterwards.
 *
 * Deliberately does not name the amount the filleul paid. That is their
 * business, and the parrain does not need it to understand the credit.
 */
export function referralRewardedEmail(
  name: string,
  { refereeName, creditedAmount, appUrl }: ReferralRewardedEmailOptions,
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Bonne nouvelle : <strong>${escapeHtml(refereeName)}</strong>, que vous
      avez parrainé, vient d'utiliser Rabotka pour la première fois 🎉
    </p>

    <p>
      🎁 Un crédit de
      <strong>${escapeHtml(creditedAmount.toLocaleString('fr-FR'))} FCFA</strong>
      a été ajouté à votre portefeuille. Vous pouvez l'utiliser dès maintenant
      pour débloquer un contact.
    </p>

    ${emailButton(appUrl, 'Ouvrir Rabotka')}

    <p>
      Continuez à partager votre code de parrainage avec les personnes de
      confiance autour de vous.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
