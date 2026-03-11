export function paymentApprovedMessage(
  firstName: string,
  profileType: 'WORKER' | 'EMPLOYER',
): string {
  const typeLabel = profileType === 'WORKER' ? 'Travailleur' : 'Employeur';

  return [
    `Bonjour ${firstName} 👋`,
    '',
    '✅ Votre paiement a été confirmé.',
    'Votre compte *Rabotka* est maintenant actif.',
    '',
    `Type de compte : ${typeLabel}`,
    'Statut : Actif',
    '',
    '👉 Tapez *Menu* pour commencer à utiliser la plateforme.',
    '',
    'Bienvenue dans la communauté Rabotka 🚀',
  ].join('\n');
}
