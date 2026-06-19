import { escapeHtml } from './layout';

export function adminUpdatedEmail(name: string): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Les informations de votre compte administrateur ont été mises à jour.</p>

    <p>
      Si vous n'avez pas effectué cette modification ou si vous pensez qu'il s'agit
      d'une erreur, veuillez contacter votre super administrateur immédiatement.
    </p>

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
