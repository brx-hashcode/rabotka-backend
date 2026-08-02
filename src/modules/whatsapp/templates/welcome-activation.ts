export function welcomeActivationMessage(
  firstName: string,
  creditAmount: number,
  profileType: 'WORKER' | 'EMPLOYER',
  walletBalance: number = 0,
): string {
  const actions =
    profileType === 'WORKER'
      ? [
          "• Consulter les offres d'emploi",
          '• Postuler à une offre',
          '• Voir vos offres recommandées',
          '• Utiliser votre crédit pour vos prochaines actions',
        ]
      : [
          "• Publier une offre d'emploi",
          '• Consulter les profils de travailleurs recommandés',
          '• Gérer vos candidatures reçues',
          '• Utiliser votre crédit pour vos prochaines actions',
        ];

  const creditLine =
    creditAmount > 0
      ? `Vous avez reçu un crédit de bienvenue de *${creditAmount} FCFA* dans votre portefeuille 🎁`
      : '';

  const balanceLine =
    creditAmount > 0 ? `Solde actuel : *${walletBalance} FCFA*` : '';

  return (
    `Bienvenue sur la plateforme, ${firstName} ! 🎉\n` +
    `\n` +
    `Votre numéro WhatsApp a bien été vérifié et votre profil est maintenant activé.\n` +
    `\n` +
    creditLine +
    `Vous pouvez maintenant :\n` +
    actions.join('\n') +
    `` +
    balanceLine +
    ``
  );
}
