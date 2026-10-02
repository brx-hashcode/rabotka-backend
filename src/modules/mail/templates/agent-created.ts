import { escapeHtml } from './layout';

/** Sent when an admin creates a field agent. There is no password to set. */
export function agentCreatedEmail(firstName: string): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>

    <p>Votre compte agent Rabotka a été créé.</p>

    <p>
      Pour vous connecter à l'application agent, saisissez cette adresse
      e-mail : vous recevrez un code de connexion à usage unique.
      Aucun mot de passe n'est nécessaire.
    </p>

    <p>
      Si vous n'attendiez pas ce message, contactez l'équipe Rabotka.
    </p>

    <p>
      Bienvenue,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
