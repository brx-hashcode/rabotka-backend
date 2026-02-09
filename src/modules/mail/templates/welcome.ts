import { escapeHtml, wrapEmailHtml } from './layout';

export function sendWelcomeEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Votre profil a bien été créé avec succès 🎉</p>

    <p>
      Pour profiter pleinement de nos services, nous vous invitons à compléter votre profil en ajoutant une photo et vos informations personnelles.
    </p>

    <p>
      Une fois votre profil vérifié, vous recevrez un lien sur WhatsApp pour activer votre compte.
    </p>

    <p>
      Si vous avez la moindre question ou besoin d'assistance,
      n'hésitez pas à nous contacter. Nous sommes là pour vous accompagner.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
