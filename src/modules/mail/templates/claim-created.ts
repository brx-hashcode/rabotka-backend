import { escapeHtml, wrapEmailHtml } from './layout';

export function claimCreatedEmail(name: string, title: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Votre réclamation <strong>"${escapeHtml(title)}"</strong> a été <strong>créée avec succès</strong>.</p>
    <p>Notre équipe va l'examiner dans les plus brefs délais et vous tiendra informé(e) de son évolution.</p>
    <p>Merci de votre confiance,<br /><strong>L'équipe Rabotka</strong></p>
  `;
  return wrapEmailHtml(body);
}
