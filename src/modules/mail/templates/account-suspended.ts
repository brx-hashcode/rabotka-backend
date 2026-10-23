import { escapeHtml } from './layout';
import { signOff, type EmailAudience } from '../audience';

export function accountSuspendedEmail(
  name: string,
  reason?: string,
  audience: EmailAudience = 'worker',
): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';
  const account =
    audience === 'business' ? 'votre compte Rabotka Business' : 'votre compte';
  // A business reaches support from its space or by replying; the others
  // mostly through WhatsApp, which the shared wording leaves open.
  const contact =
    audience === 'business'
      ? 'répondez à cet e-mail ou contactez notre équipe depuis votre espace.'
      : 'veuillez contacter notre équipe support.';

  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Nous vous informons que ${account} a été <strong>suspendu</strong>.
    </p>

    ${reasonBlock}

    <p>
      Si vous pensez qu'il s'agit d'une erreur ou souhaitez obtenir plus d'informations,
      ${contact}
    </p>

    <p>
      Cordialement,<br />
      <strong>${signOff(audience)}</strong>
    </p>
  `;
}
