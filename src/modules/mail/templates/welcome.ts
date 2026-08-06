import { emailButton, escapeHtml } from './layout';

export type WelcomeEmailOptions = {
  /** Where the CTA points. Not a one-tap link — those are minted for WhatsApp. */
  appUrl: string;
  /** Granted at signup by `grantWelcomeCredit`; 0 when the grant failed. */
  creditedBalance: number;
};

/** Shown by the client on the same event, so both channels read alike. */
export const WELCOME_EMAIL_PREVIEW =
  "Votre profil est créé. Plus qu'une vérification avant l'activation.";

/**
 * Sent the moment a profile is created (`profile.controller.ts`).
 *
 * The account is `PENDING_ACTIVATION` at this point and the KYC documents are
 * already submitted, so this email is a receipt, not a task list. It used to ask
 * the user to "compléter votre profil (photo et informations personnelles)" to
 * activate their account — information they had just submitted — and to expect a
 * verification call that no code path has ever made.
 *
 * The closing line matches the onboarding success screen word for word
 * (`content/onboarding/modals.ts`), so the two messages a new user receives at
 * the same moment agree with each other.
 */
export function sendWelcomeEmail(
  name: string,
  { appUrl, creditedBalance }: WelcomeEmailOptions,
): string {
  // Hidden entirely when the grant failed, matching the success screen — an
  // empty gift box reads worse than no gift box.
  const creditBlock =
    creditedBalance > 0
      ? `
    <p>
      🎁 Un crédit de bienvenue de
      <strong>${escapeHtml(creditedBalance.toLocaleString('fr-FR'))} FCFA</strong>
      a été ajouté à votre portefeuille.
    </p>`
      : '';

  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Votre profil a été créé avec succès 🎉</p>

    <p>
      Une fois vos informations vérifiées, votre compte sera activé.
      Un agent Rabotka examine actuellement les documents que vous avez transmis.
    </p>
${creditBlock}
    ${emailButton(appUrl, 'Ouvrir Rabotka')}

    <p>Vous recevrez un message sur WhatsApp dès que votre compte sera activé.</p>

    <p>
      Pour toute question, notre équipe reste à votre disposition.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
