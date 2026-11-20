import { displayPhone, emailButton, escapeHtml } from './layout';

export const DEMO_REQUEST_RECEIVED_SUBJECT =
  'Votre demande de démo Rabotka Business est bien reçue';

/** The promise made to every requester, in the e-mail and its preview. */
export const DEMO_REQUEST_DELAY = 'sous 24 à 48 h ouvrées';

/** The form may send the prefix without its « + » (« 242 069917686 »). */
const withPlus = (phone: string) =>
  phone.trim().startsWith('+') ? phone.trim() : `+${phone.trim()}`;

/** A headcount bracket (BUSINESS_SIZES) as people say it. */
export function companySizeLabel(size: string): string {
  const range = /^(\d+)-(\d+)$/.exec(size.trim());
  if (range) return `${range[1]} à ${range[2]} salariés`;
  const open = /^(\d+)\+$/.exec(size.trim());
  if (open) return `Plus de ${open[1]} salariés`;
  return `${size.trim()} salariés`;
}

/** One « label / value » line of the recap box: the label above its value. */
function recapRow(label: string, value: string, last = false): string {
  return `
      <tr>
        <td style="padding:0 0 ${last ? 0 : 14}px;vertical-align:top;">
          <p style="margin:0 0 2px;font-size:12px;line-height:1.4;color:#6b7570;">${escapeHtml(label)}</p>
          <p style="margin:0;font-size:15px;line-height:1.45;font-weight:600;color:#2a322e;">${value}</p>
        </td>
      </tr>`;
}

/** Two recap rows side by side, stacked by narrow clients that wrap cells. */
function recapPair(
  left: [string, string],
  right: [string, string],
  last = false,
): string {
  const cell = ([label, value]: [string, string]) => `
        <td width="50%" style="padding:0 12px ${last ? 0 : 14}px 0;vertical-align:top;">
          <p style="margin:0 0 2px;font-size:12px;line-height:1.4;color:#6b7570;">${escapeHtml(label)}</p>
          <p style="margin:0;font-size:15px;line-height:1.45;font-weight:600;color:#2a322e;">${value}</p>
        </td>`;
  return `
      <tr>
        <td style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>${cell(left)}${cell(right)}</tr>
          </table>
        </td>
      </tr>`;
}

/** The chosen features, as small tags. */
function tags(labels: string[]): string {
  return labels
    .map(
      (label) =>
        `<span style="display:inline-block;margin:4px 6px 0 0;padding:4px 10px;border-radius:999px;background:#ffffff;font-size:13px;font-weight:600;color:#2a322e;">${escapeHtml(label)}</span>`,
    )
    .join('');
}

/** A numbered step of « Et maintenant ? ». */
function step(n: number, text: string): string {
  return `
      <tr>
        <td style="padding:6px 12px 6px 0;width:28px;vertical-align:top;">
          <span style="display:inline-block;width:24px;height:24px;line-height:24px;border-radius:12px;background:#cbffa5;color:#0f2414;font-size:13px;font-weight:700;text-align:center;">${n}</span>
        </td>
        <td style="padding:8px 0 6px;vertical-align:top;font-size:15px;line-height:1.5;color:#2a322e;">${text}</td>
      </tr>`;
}

/**
 * To the person who asked for a demo, right after the form: what was
 * received, and what happens next. The only e-mail a demo request sends;
 * staff see it in the admin bell.
 */
export function demoRequestReceivedEmail(params: {
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string;
  company: string;
  country: string;
  companySize: string;
  phone: string;
  interests: string[];
  message: string | null;
  siteUrl: string;
}): string {
  const contact = [
    `${params.firstName} ${params.lastName}`.trim(),
    params.jobTitle.trim(),
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  const message = params.message?.trim()
    ? escapeHtml(params.message.trim()).replace(/\r?\n/g, '<br />')
    : null;

  // A pair sits side by side; the last row has no bottom spacing (the box's
  // padding is enough).
  type Row = [string, string] | [[string, string], [string, string]];
  const rows: Row[] = [
    ['Entreprise', escapeHtml(params.company)],
    [
      ['Pays', escapeHtml(params.country)],
      ['Effectif', escapeHtml(companySizeLabel(params.companySize))],
    ],
    ['Contact', contact],
    [
      ['Téléphone', escapeHtml(displayPhone(withPlus(params.phone)))],
      ['E-mail', escapeHtml(params.email)],
    ],
  ];
  if (params.interests.length) {
    rows.push(['Ce que vous souhaitez voir', tags(params.interests)]);
  }
  if (message) {
    rows.push([
      'Votre message',
      `<span style="font-weight:400;">${message}</span>`,
    ]);
  }
  const recap = rows
    .map((row, i) => {
      const last = i === rows.length - 1;
      return typeof row[0] === 'string'
        ? recapRow(row[0], row[1] as string, last)
        : recapPair(row[0], row[1] as [string, string], last);
    })
    .join('');

  return `
    <p>Bonjour ${escapeHtml(params.firstName)},</p>

    <p>
      Merci pour votre intérêt pour Rabotka Business. Votre demande de démo
      pour <strong>${escapeHtml(params.company)}</strong> est bien reçue.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:separate;background:#f1f4f8;border-radius:12px;">
      <tr>
        <td style="padding:20px;">
          <p style="margin:0 0 16px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7570;">Votre demande</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${recap}
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:24px 0 8px;font-weight:600;">Et maintenant ?</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${step(1, `Un membre de notre équipe vous contacte <strong>${DEMO_REQUEST_DELAY}</strong>, par téléphone ou par e-mail.`)}
      ${step(2, 'Ensemble, vous fixez un créneau de 30 minutes, en visio ou au téléphone.')}
      ${step(3, 'Nous vous montrons Rabotka sur vos vrais recrutements : vos offres, vos candidats, vos entretiens.')}
    </table>

    <p style="margin-top:24px;">En attendant, découvrez ce que Rabotka Business fait pour vous :</p>

    ${emailButton(`${params.siteUrl}/fonctionnalites`, 'Voir les fonctionnalités')}

    <p>À très bientôt,<br /><strong>L’équipe Rabotka Business</strong></p>
  `;
}
