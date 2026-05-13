import { escapeHtml, wrapEmailHtml } from './layout';

export function claimRejectedEmail(name: string, title: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Nous vous informons que votre réclamation <strong>"${escapeHtml(title)}"</strong> a été <strong>rejetée</strong>.</p>
    <p>Si vous estimez que cette décision est incorrecte ou si vous avez besoin de plus d'informations, veuillez nous contacter directement.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
  return wrapEmailHtml(body);
}
