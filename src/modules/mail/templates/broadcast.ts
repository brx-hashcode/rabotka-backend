import { emailButton, escapeHtml } from './layout';
import { appUrlFor, signOff, type EmailAudience } from '../audience';

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
  body: string;
  link: string | null;
  audience?: EmailAudience;
}): string {
  const audience = p.audience ?? 'worker';
  const paragraphs = escapeHtml(p.body)
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('\n');

  // The link is a client-app path: a business has none of those pages, so
  // its button opens its own space instead.
  const cta = !p.link
    ? ''
    : audience === 'business'
      ? emailButton(appUrlFor('business'), 'Accéder à mon espace')
      : emailButton(
          `${appUrlFor(audience)}/${p.link.replace(/^\/+/, '')}`,
          'Ouvrir Rabotka',
        );

  // NO TITLE IN THE BODY. The broadcast's title is already the SUBJECT LINE,
  // and repeating it as a heading made every announcement open by saying the
  // same sentence twice — once in the client's header, once again under the
  // greeting. An email is not a web page; its heading is the subject.
  return `
    <p>Bonjour ${escapeHtml(p.firstName)},</p>

    ${paragraphs}

    ${cta}

    <p>
      Cordialement,<br />
      <strong>${signOff(audience)}</strong>
    </p>
  `;
}
