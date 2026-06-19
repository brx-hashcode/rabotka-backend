import { escapeHtml } from './layout';

export function claimCompletedEmail(name: string, title: string): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Bonne nouvelle ! Votre réclamation <strong>"${escapeHtml(title)}"</strong> a été <strong>résolue avec succès</strong>.</p>
    <p>Si vous avez d'autres questions ou préoccupations, n'hésitez pas à nous contacter.</p>
    <p>Merci de votre confiance,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
