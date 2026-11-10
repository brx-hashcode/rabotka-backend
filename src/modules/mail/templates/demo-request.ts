import { displayPhone, emailButton, escapeHtml } from './layout';

export const DEMO_REQUEST_RECEIVED_SUBJECT =
  'Votre demande de démo Rabotka Business est bien reçue';

/** The form may send the prefix without its « + » (« 242 069917686 »). */
const withPlus = (phone: string) =>
  phone.trim().startsWith('+') ? phone.trim() : `+${phone.trim()}`;

/** One « label : value » line of the recap box. */
function recapRow(label: string, value: string): string {
  return `
      <tr>
        <td style="padding:6px 0;width:42%;vertical-align:top;font-size:14px;color:#6b7570;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;vertical-align:top;font-size:14px;font-weight:600;color:#2a322e;">${value}</td>
      </tr>`;
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
  company: string;
  country: string;
  companySize: string;
  phone: string;
  interests: string[];
  siteUrl: string;
}): string {
  const interests = params.interests.length
    ? params.interests.map(escapeHtml).join(', ')
    : null;
  return `
    <p>Bonjour ${escapeHtml(params.firstName)},</p>

    <p>
      Merci pour votre intérêt pour Rabotka Business. Votre demande de démo
      pour <strong>${escapeHtml(params.company)}</strong> est bien reçue.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:separate;background:#f1f4f8;border-radius:12px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7570;">Votre demande</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${recapRow('Entreprise', escapeHtml(params.company))}
            ${recapRow('Pays', escapeHtml(params.country))}
            ${recapRow('Effectif', `${escapeHtml(params.companySize)} salariés`)}
            ${recapRow('Téléphone', escapeHtml(displayPhone(withPlus(params.phone))))}
            ${interests ? recapRow('Ce qui vous intéresse', interests) : ''}
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:24px 0 8px;font-weight:600;">Et maintenant ?</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${step(1, 'Un membre de notre équipe vous appelle <strong>sous 24 h ouvrées</strong>.')}
      ${step(2, 'Ensemble, vous fixez un créneau de 30 minutes, en visio ou au téléphone.')}
      ${step(3, 'Nous vous montrons Rabotka sur vos vrais recrutements : vos offres, vos candidats, vos entretiens.')}
    </table>

    <p style="margin-top:24px;">En attendant, découvrez ce que Rabotka Business fait pour vous :</p>

    ${emailButton(`${params.siteUrl}/fonctionnalites`, 'Voir les fonctionnalités')}

    <p>À très bientôt,<br /><strong>L’équipe Rabotka Business</strong></p>
  `;
}
