import { escapeHtml, wrapEmailHtml } from './layout';

export function sendOtpEmail(code: string): string {
  const body = `

    <p>Bonjour,</p>

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

  return wrapEmailHtml(body, {
    previewText: `Votre code de vérification Rabotka : ${code}`,
  });
}
