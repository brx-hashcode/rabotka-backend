export function accountActivationMessage(paymentUrl: string): string {
  return [
    'Votre numéro WhatsApp a été vérifié avec succès.',
    '',
    'Pour activer votre compte Rabotka, veuillez finaliser votre paiement en cliquant sur le lien ci-dessous :',
    '',
    `${paymentUrl}`,
    '',
    'Une fois le paiement confirmé, votre compte sera automatiquement activé.',
    '',
    'Merci et bienvenue sur Rabotka !',
  ].join('\n');
}
