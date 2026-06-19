import { escapeHtml } from './layout';

export function claimUnassignedEmail(adminName: string, title: string): string {
  return `
    <p>Bonjour ${escapeHtml(adminName)},</p>
    <p>La réclamation <strong>"${escapeHtml(title)}"</strong> ne vous est <strong>plus assignée</strong>.</p>
    <p>Aucune action supplémentaire n'est requise de votre part.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
