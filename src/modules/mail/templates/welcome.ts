import { escapeHtml, wrapEmailHtml } from './layout';

export function sendWelcomeEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Votre profil a bien été créé avec succès 🎉</p>

    <p>
      Nous procédons actuellement à la vérification de vos informations.
      Une fois votre profil validé, vous recevrez un lien sur WhatsApp afin de
      finaliser et activer votre compte.
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
