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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function eventUpdatedEmail(
  name: string,
  title: string,
  startDate: string,
  endDate: string,
  description?: string | null,
  location?: string | null,
): string {
  const date = formatDate(startDate);
  const start = formatTime(startDate);
  const end = formatTime(endDate);

  const descriptionLine = description
    ? `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
          <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Description</span><br/>
          <span style="font-size: 15px; color: #222;">${escapeHtml(description)}</span>
        </td>
      </tr>`
    : '';

  const locationLine = location
    ? `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
          <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Lieu</span><br/>
          <span style="font-size: 15px; color: #222;">${escapeHtml(location)}</span>
        </td>
      </tr>`
    : '';

  const body = `
    <p style="font-size: 16px; color: #333;">Bonjour <strong>${escapeHtml(name)}</strong>,</p>
    <p style="color: #555;">Les horaires de l'événement suivant ont été modifiés :</p>

    <div style="background: #f9f9f9; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 20px 24px; margin: 20px 0;">
      <h2 style="margin: 0 0 16px 0; font-size: 20px; color: #111;">${escapeHtml(title)}</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
            <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Nouvelle date</span><br/>
            <span style="font-size: 15px; color: #222;">${escapeHtml(date)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
            <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Nouvel horaire</span><br/>
            <span style="font-size: 15px; color: #222;">${escapeHtml(start)} – ${escapeHtml(end)}</span>
          </td>
        </tr>
        ${locationLine}
        ${descriptionLine}
      </table>
    </div>

    <p style="color: #555;">Merci de bien vouloir mettre à jour votre agenda.</p>
    <p style="color: #333;">Cordialement,<br/><strong>L'équipe Rabotka</strong></p>
  `;

  return wrapEmailHtml(body, {
    previewText: `Mise à jour : ${title} — ${date}`,
  });
}
