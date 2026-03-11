export function paymentLinkMessage(
  firstName: string,
  paymentUrl: string,
): string {
  return [
    `Bonjour ${firstName},`,
    '',
    'Votre lien de paiement Rabotka est prêt.',
    'Cliquez sur le lien ci-dessous pour finaliser votre paiement et activer votre compte :',
    '',
    `${paymentUrl}`,
    '',
    'Une fois le paiement confirmé, votre compte sera automatiquement activé.',
    'Ce lien est personnel et sécurisé.',
    '',
    'Merci et bienvenue sur Rabotka !',
  ].join('\n');
}
