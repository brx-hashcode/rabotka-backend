import { escapeHtml, wrapEmailHtml } from './layout';

export function claimInProgressEmail(name: string, title: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Votre réclamation <strong>"${escapeHtml(title)}"</strong> est désormais <strong>en cours de traitement</strong>.</p>
    <p>Notre équipe travaille activement pour la résoudre. Nous vous tiendrons informé(e) dès qu'il y aura du nouveau.</p>
    <p>Merci de votre patience,<br /><strong>L'équipe Rabotka</strong></p>
  `;
  return wrapEmailHtml(body);
}
