import { escapeHtml } from './layout';

export function claimAssignedEmail(adminName: string, title: string): string {
  return `
    <p>Bonjour ${escapeHtml(adminName)},</p>
    <p>La réclamation <strong>"${escapeHtml(title)}"</strong> vous a été <strong>assignée</strong>.</p>
    <p>Veuillez vous connecter à l'espace administrateur pour la traiter dans les meilleurs délais.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
