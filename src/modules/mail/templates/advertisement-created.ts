import { escapeHtml, wrapEmailHtml } from './layout';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function toHtmlParagraphs(text: string): string {
  return escapeHtml(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => (line.length === 0 ? '<br />' : line))
    .join('<br />');
}

export function advertisementCreatedEmail(
  params: {
    name: string;
    title: string;
    startDate: string;
    endDate: string;
    description?: string | null;
    callToAction?: string | null;
    ctaUrl?: string | null;
    imageUrl?: string | null;
  },
): string {
  const start = formatDate(params.startDate);
  const end = formatDate(params.endDate);
  const safeCtaUrl = params.ctaUrl ? escapeHtml(params.ctaUrl) : null;

  const body = `
    <p>Bonjour <strong>${escapeHtml(params.name)}</strong>,</p>
    <p>Vous avez une nouvelle annonce sur Rabotka :</p>
    <p style="font-size: 18px; font-weight: 700; margin: 8px 0 4px;">${escapeHtml(params.title)}</p>
    <p><strong>Du</strong> ${escapeHtml(start)} <strong>au</strong> ${escapeHtml(end)}</p>
    ${params.imageUrl ? `<p><img src="${escapeHtml(params.imageUrl)}" alt="${escapeHtml(params.title)}" style="max-width: 100%; border-radius: 8px; object-fit: cover;" /></p>` : ''}
    ${params.description ? `<p>${toHtmlParagraphs(params.description)}</p>` : ''}
    ${safeCtaUrl ? `<p>Pour plus d'informations : <a href="${safeCtaUrl}">${escapeHtml(params.callToAction?.trim() || 'En savoir plus')}</a></p>` : ''}
    <p>Si vous avez des questions, n'hésitez pas à nous contacter.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Nouvelle annonce : ${params.title}`,
  });
}
