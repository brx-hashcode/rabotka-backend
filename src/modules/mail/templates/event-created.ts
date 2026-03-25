import { escapeHtml, wrapEmailHtml } from './layout';

export function eventCreatedEmail(
  name: string,
  title: string,
  startDate: string,
  endDate: string,
  location?: string | null,
): string {
  const locationLine = location
    ? `<p><strong>Lieu :</strong> ${escapeHtml(location)}</p>`
    : '';

  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Vous avez été invité(e) à l'événement suivant :</p>
    <p><strong>${escapeHtml(title)}</strong></p>
    <p><strong>Date de début :</strong> ${escapeHtml(startDate)}</p>
    <p><strong>Date de fin :</strong> ${escapeHtml(endDate)}</p>
    ${locationLine}
    <p>Merci,<br /><strong>L'équipe Rabotka</strong></p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Nouvel événement : ${title}`,
  });
}
