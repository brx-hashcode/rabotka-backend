import { emailButton, escapeHtml } from './layout';

/** To the company that asked for a demo, right after the form. */
export function demoRequestReceivedEmail(params: {
  firstName: string;
  company: string;
  siteUrl: string;
}): string {
  return `
    <p>Bonjour ${escapeHtml(params.firstName)},</p>

    <p>
      Merci pour votre demande de démo de Rabotka Business pour
      <strong>${escapeHtml(params.company)}</strong>.
    </p>

    <p>
      Un membre de notre équipe vous recontacte sous 24 h ouvrées pour convenir
      d'un créneau de 30 minutes. Nous vous montrerons Rabotka sur vos vrais
      recrutements : vos offres, vos candidats, vos entretiens.
    </p>

    <p>En attendant, vous pouvez découvrir ce que Rabotka Business fait pour vous :</p>

    ${emailButton(`${params.siteUrl}/fonctionnalites`, 'Voir les fonctionnalités')}

    <p>Cordialement,<br /><strong>L'équipe Rabotka Business</strong></p>
  `;
}

/** To staff: a company to call back. */
export function demoRequestStaffEmail(params: {
  staffFirstName: string;
  name: string;
  jobTitle: string;
  company: string;
  country: string;
  companySize: string;
  email: string;
  phone: string;
  interests: string[];
  message: string | null;
  reviewUrl: string;
}): string {
  const interests = params.interests.length
    ? params.interests.map(escapeHtml).join(', ')
    : '—';
  const message = params.message
    ? `<p><strong>Message :</strong><br />${escapeHtml(params.message).replace(/\n/g, '<br />')}</p>`
    : '';
  return `
    <p>Bonjour ${escapeHtml(params.staffFirstName)},</p>

    <p>Une entreprise demande une démo de Rabotka Business :</p>

    <p>
      <strong>${escapeHtml(params.company)}</strong> · ${escapeHtml(params.country)} · ${escapeHtml(params.companySize)} personnes<br />
      ${escapeHtml(params.name)}, ${escapeHtml(params.jobTitle)}<br />
      ${escapeHtml(params.email)} · ${escapeHtml(params.phone)}
    </p>

    <p><strong>Intéressé par :</strong> ${interests}</p>
    ${message}

    ${emailButton(params.reviewUrl, 'Voir la demande')}

    <p>Rappelez-la sous 24 h ouvrées : c'est ce que le site lui promet.</p>
  `;
}
