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

export const BUSINESS_WELCOME_EMAIL_PREVIEW =
  'Le compte de votre organisation est créé. Notre équipe vérifie vos documents.';

/**
 * The welcome for a business sign-up. Not the worker/employer one: a business
 * works from its dashboard, by email only — no client app, no WhatsApp, and
 * its welcome credit comes with the verification, not the sign-up.
 */
export function businessWelcomeEmail(
  name: string,
  {
    businessName,
    organisationUrl,
  }: { businessName: string; organisationUrl: string },
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Le compte de <strong>${escapeHtml(businessName)}</strong> est créé sur
      Rabotka Business.
    </p>

    <p>
      Notre équipe vérifie maintenant les documents de votre organisation. Vous
      recevrez le résultat par e-mail et dans votre espace. Si un document doit
      être remplacé, vous pourrez le faire directement depuis la rubrique
      « Mon organisation ».
    </p>

    ${emailButton(organisationUrl, 'Accéder à mon espace')}

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>
  `;
}
