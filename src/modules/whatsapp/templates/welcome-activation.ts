export function welcomeActivationMessage(
  firstName: string,
  creditAmount: number,
  profileType: 'WORKER' | 'EMPLOYER',
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

  return (
    `Bienvenue sur la plateforme, ${firstName} ! 🎉\n` +
    `\n` +
    `Votre numéro WhatsApp a bien été vérifié et votre profil est maintenant activé.\n` +
    `\n` +
    `Vous avez reçu un crédit de bienvenue de *${creditAmount} FCFA* dans votre portefeuille 🎁\n` +
    `\n` +
    `Vous pouvez maintenant :\n` +
    actions.join('\n') +
    `\n` +
    `\n` +
    `Solde actuel : *${creditAmount} FCFA*\n` +
    `\n` +
    `Tapez *MENU* pour commencer.`
  );
}
