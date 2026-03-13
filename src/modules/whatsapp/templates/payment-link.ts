export function paymentLinkMessage(paymentUrl: string): string {
  return [
    'Votre lien de paiement est prêt.',
    'Cliquez sur le lien ci-dessous pour finaliser votre paiement et activer votre compte :',
    '',
    paymentUrl,
    '',
    'Une fois le paiement confirmé, votre compte sera automatiquement activé.',
    '',
    'Merci et bienvenue !',
  ].join('\n');
}
