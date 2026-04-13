export function welcomeActivationMessage(
  firstName: string,
  creditAmount: number,
  profileType: 'WORKER' | 'EMPLOYER',
  walletBalance: number = 0,
): string {
  const actions =
    profileType === 'WORKER'
      ? [
          "• Consulter les offres d'emploi disponibles",
          '• Postuler à une mission',
          '• Voir vos offres recommandées (tapez *3* au menu)',
          '• Utiliser votre crédit pour vos prochaines actions',
        ]
      : [
          "• Publier une offre d'emploi",
          '• Consulter les profils de travailleurs recommandés (tapez *5* au menu)',
          '• Gérer vos candidatures reçues',
          '• Utiliser votre crédit pour vos prochaines actions',
        ];

  const creditLine =
    creditAmount > 0
      ? `Vous avez reçu un crédit de bienvenue de *${creditAmount} FCFA* dans votre portefeuille 🎁\n\n`
      : '';

  const balanceLine =
    creditAmount > 0 ? `Solde actuel : *${walletBalance} FCFA*\n\n` : '';

  return (
    `Bienvenue sur la plateforme, ${firstName} ! 🎉\n` +
    `\n` +
    `Votre numéro WhatsApp a bien été vérifié et votre profil est maintenant activé.\n` +
    `\n` +
    creditLine +
    `Vous pouvez maintenant :\n` +
    actions.join('\n') +
    `\n\n` +
    balanceLine +
    `Tapez *MENU* pour commencer.`
  );
}
