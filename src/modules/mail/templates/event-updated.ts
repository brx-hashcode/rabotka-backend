import { escapeHtml, wrapEmailHtml } from './layout';

export function eventUpdatedEmail(
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
    <p>Les dates de l'événement auquel vous participez ont été mises à jour :</p>
    <p><strong>${escapeHtml(title)}</strong></p>
    <p><strong>Nouvelle date de début :</strong> ${escapeHtml(startDate)}</p>
    <p><strong>Nouvelle date de fin :</strong> ${escapeHtml(endDate)}</p>
    ${locationLine}
    <p>Merci,<br /><strong>L'équipe Rabotka</strong></p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Mise à jour de l'événement : ${title}`,
  });
}
