export function paymentApprovedMessage(firstName: string): string {
  return [
    `Bonjour ${firstName} 👋`,
    '',
    'Votre paiement a été confirmé.',
    'Votre compte *Rabotka* est maintenant actif.',
    '',
    '',
    '',
    'Bienvenue dans la communauté Rabotka 🚀',
  ].join('\n');
}
