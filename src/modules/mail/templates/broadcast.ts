import { escapeHtml } from './layout';

/**
 * An admin announcement, as an email.
 *
 * The only template here whose body is written by the sender rather than by
 * this file, so it is the only one that must escape its input: an admin typing
 * `<` into the composer should not be able to produce markup in a thousand
 * inboxes. Line breaks survive as `<br />` because the composer is a textarea
 * and its paragraphs are the shape of the message.
 */
export function broadcastEmail(p: {
  firstName: string;
  title: string;
  body: string;
  link: string | null;
}): string {
  const paragraphs = escapeHtml(p.body)
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('\n');

  const appUrl = process.env.FRONTEND_URL ?? 'https://rabotka.work';
  const cta = p.link
    ? `<p><a href="${appUrl}/${escapeHtml(p.link.replace(/^\/+/, ''))}">Ouvrir Rabotka</a></p>`
    : '';

  return `
    <p>Bonjour ${escapeHtml(p.firstName)},</p>

    <h2>${escapeHtml(p.title)}</h2>

    ${paragraphs}

    ${cta}

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
