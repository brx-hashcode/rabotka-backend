import { escapeHtml, wrapEmailHtml } from './layout';

export function accountSuspendedEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Nous vous informons que votre compte a été <strong>suspendu</strong>.
    </p>

    <p>
      Si vous pensez qu'il s'agit d'une erreur ou souhaitez obtenir plus d'informations,
      veuillez contacter notre équipe support.
    </p>

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
