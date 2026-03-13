import { escapeHtml, wrapEmailHtml } from './layout';

export function sendWelcomeEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Votre profil a été créé avec succès 🎉</p>

    <p>
      Pour activer votre compte, veuillez compléter votre profil
      (photo et informations personnelles).
    </p>

    <p>
      Un agent Rabotka pourra également vous appeler pour vérifier votre identité (KYC).
    </p>

    <p>
      Pour toute question, notre équipe reste à votre disposition.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
