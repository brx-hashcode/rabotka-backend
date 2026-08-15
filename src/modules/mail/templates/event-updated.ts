import { recurrenceLabel } from '../../../common/utils/recurrence-label.util';
import type { EventEmailParams } from './event-created';
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

export function eventUpdatedEmail({
  name,
  title,
  startDate,
  endDate,
  description,
  location,
  googleCalendarUrl,
  recurrence,
}: EventEmailParams): string {
  const date = formatDate(startDate);
  const start = formatTime(startDate);
  const end = formatTime(endDate);
  const repeats = recurrenceLabel(recurrence);

  return `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>
    <p>Les horaires de l'événement suivant ont été modifiés :</p>

    <p><strong>${escapeHtml(title)}</strong></p>
    <p><strong>Nouvelle date :</strong> ${escapeHtml(date)}</p>
    <p><strong>Nouvel horaire :</strong> ${escapeHtml(start)} – ${escapeHtml(end)}</p>
    ${repeats ? `<p><strong>Répétition :</strong> ${escapeHtml(repeats)}</p>` : ''}
    ${location ? `<p><strong>Lieu :</strong> ${escapeHtml(location)}</p>` : ''}
    ${description ? `<p><strong>Description :</strong> ${escapeHtml(description)}</p>` : ''}

    ${googleCalendarUrl ? `<p><a href="${escapeHtml(googleCalendarUrl)}" style="display: inline-block; padding: 10px 20px; background-color: #4285F4; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">📅 Mettre à jour dans Google Calendar</a></p>` : ''}

    <p>Merci de bien vouloir mettre à jour votre agenda.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
