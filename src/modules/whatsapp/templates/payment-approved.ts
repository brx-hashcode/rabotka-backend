export function paymentApprovedMessage(firstName: string): string {
  return [
    `Bonjour ${firstName} 👋`,
    '',
    'Votre paiement a été confirmé.',
    'Votre compte *Rabotka* est maintenant actif.',
    '',
    'Tapez *Menu* pour commencer à utiliser la plateforme.',
    '',
    'Bienvenue dans la communauté Rabotka 🚀',
  ].join('\n');
}
