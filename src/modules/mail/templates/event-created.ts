import { escapeHtml } from './layout';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function eventCreatedEmail(
  name: string,
  title: string,
  startDate: string,
  endDate: string,
  description?: string | null,
  location?: string | null,
  googleCalendarUrl?: string,
): string {
  const date = formatDate(startDate);
  const start = formatTime(startDate);
  const end = formatTime(endDate);

  return `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>
    <p>Vous avez été invité(e) à participer à l'événement suivant :</p>

    <p><strong>${escapeHtml(title)}</strong></p>
    <p><strong>Date :</strong> ${escapeHtml(date)}</p>
    <p><strong>Horaire :</strong> ${escapeHtml(start)} – ${escapeHtml(end)}</p>
    ${location ? `<p><strong>Lieu :</strong> ${escapeHtml(location)}</p>` : ''}
    ${description ? `<p><strong>Description :</strong> ${escapeHtml(description)}</p>` : ''}

    ${googleCalendarUrl ? `<p><a href="${escapeHtml(googleCalendarUrl)}" style="display: inline-block; padding: 10px 20px; background-color: #4285F4; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">📅 Ajouter à Google Calendar</a></p>` : ''}

    <p>Si vous avez des questions, n'hésitez pas à nous contacter.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
