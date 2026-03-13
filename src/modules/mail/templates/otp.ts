import { escapeHtml, wrapEmailHtml } from './layout';

export function sendOtpEmail(code: string): string {
  const body = `

    <p>Voici votre code de vérification : <strong>${escapeHtml(code)}</strong></p>

    <p>Ce code expire dans <strong>5 minutes</strong>.</p>
    
    <p>
      Merci,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Votre code de vérification Rabotka: ${code}`,
  });
}
