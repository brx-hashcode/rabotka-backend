import { escapeHtml, wrapEmailHtml } from './layout';

export function adminCreatedEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Votre compte administrateur a été créé avec succès sur la plateforme Rabotka.</p>

    <p>
      Vous pouvez dès maintenant vous connecter au panneau d'administration
      en utilisant votre adresse e-mail.
    </p>

    <p>
      Si vous n'êtes pas à l'origine de cette création ou si vous avez des questions,
      veuillez contacter votre super administrateur.
    </p>

    <p>
      Bienvenue dans l'équipe,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body, {
    previewText: 'Votre compte administrateur Rabotka a été créé.',
  });
}
