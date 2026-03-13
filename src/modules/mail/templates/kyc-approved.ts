import { escapeHtml, wrapEmailHtml } from './layout';

export function kycApprovedEmail(name: string): string {
  const body = `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>Bonne nouvelle ! 🎉 Votre vérification d'identité (KYC) a été <strong>approuvée avec succès</strong>.</p>

    <p>
      Pour finaliser l'activation de votre compte, vous allez recevoir un message WhatsApp
      contenant un <strong>lien de vérification</strong> pour confirmer que votre numéro de téléphone
      est bien connecté à WhatsApp.
    </p>

    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;

  return wrapEmailHtml(body);
}
