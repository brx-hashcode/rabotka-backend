import { escapeHtml, wrapEmailHtml } from './layout';

export function kycApprovedEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Bonne nouvelle ! 🎉 Votre vérification d'identité (KYC) a été <strong>approuvée avec succès</strong>.</p>

    <p>
      Pour accéder à la plateforme, ouvrez WhatsApp et tapez <strong>Menu</strong> dans votre conversation
      avec Rabotka. Votre compte sera activé instantanément.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
