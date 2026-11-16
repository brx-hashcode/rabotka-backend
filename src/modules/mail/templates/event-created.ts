import {
  recurrenceLabel,
  type RecurrenceLabelInput,
} from '../../../common/utils/recurrence-label.util';
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

export type EventEmailParams = {
  name: string;
  title: string;
  startDate: string;
  endDate: string;
  description?: string | null;
  location?: string | null;
  googleCalendarUrl?: string;
  /** Set when the event repeats — see the note by `repeats` below. */
  recurrence?: RecurrenceLabelInput | null;
  /** A profile's own link to the event's visio. */
  visioUrl?: string | null;
  /** An admin: the visio opens from Rabotka Admin. */
  visioInAdmin?: boolean;
};

/** The visio line: a button for a profile, a pointer for an admin. */
export function visioHtml(
  visioUrl?: string | null,
  visioInAdmin?: boolean,
): string {
  if (visioUrl) {
    return `<p><strong>Visio :</strong> ce lien est personnel, il vous fait entrer dans la réunion sous votre nom (dès 15 minutes avant le début).</p>
    <p><a href="${escapeHtml(visioUrl)}" style="display: inline-block; padding: 10px 20px; background-color: #00B32C; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">Rejoindre la visio</a></p>`;
  }
  if (visioInAdmin) {
    return '<p><strong>Visio :</strong> à rejoindre depuis Rabotka Admin, page HR events.</p>';
  }
  return '';
}

export function eventCreatedEmail({
  name,
  title,
  startDate,
  endDate,
  description,
  location,
  googleCalendarUrl,
  recurrence,
  visioUrl,
  visioInAdmin,
}: EventEmailParams): string {
  const date = formatDate(startDate);
  const start = formatTime(startDate);
  const end = formatTime(endDate);
  // A series is announced once, so this line is the only thing telling the
  // recipient that the date above is the first of several. The attached .ics
  // carries the same rule for their calendar app.
  const repeats = recurrenceLabel(recurrence);

  return `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>
    <p>Vous avez été invité(e) à participer à l'événement suivant :</p>

    <p><strong>${escapeHtml(title)}</strong></p>
    <p><strong>Date :</strong> ${escapeHtml(date)}</p>
    <p><strong>Horaire :</strong> ${escapeHtml(start)} – ${escapeHtml(end)}</p>
    ${repeats ? `<p><strong>Répétition :</strong> ${escapeHtml(repeats)}</p>` : ''}
    ${location ? `<p><strong>Lieu :</strong> ${escapeHtml(location)}</p>` : ''}
    ${visioHtml(visioUrl, visioInAdmin)}
    ${description ? `<p><strong>Description :</strong> ${escapeHtml(description)}</p>` : ''}

    ${googleCalendarUrl ? `<p><a href="${escapeHtml(googleCalendarUrl)}" style="display: inline-block; padding: 10px 20px; background-color: #4285F4; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">📅 Ajouter à Google Calendar</a></p>` : ''}

    <p>Si vous avez des questions, n'hésitez pas à nous contacter.</p>
    <p>Cordialement,<br /><strong>L'équipe Rabotka</strong></p>
  `;
}
