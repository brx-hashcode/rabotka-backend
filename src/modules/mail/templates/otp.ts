import { escapeHtml } from './layout';

export function sendOtpEmail(code: string, first_name?: string): string {
  const greeting = first_name ? `Bonjour ${first_name},` : 'Bonjour,';
  return `
    <p>${greeting}</p>

    <p>
      Voici votre code de vérification :
      <strong>${escapeHtml(code)}</strong>
    </p>

    <p>
      Pour des raisons de sécurité, ce code est valable pendant
      <strong>5 minutes</strong>.
    </p>

    <p>
      Si vous n'avez pas demandé ce code, vous pouvez ignorer cet email.
    </p>

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
