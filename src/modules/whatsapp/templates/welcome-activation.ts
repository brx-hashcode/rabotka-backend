export function welcomeActivationMessage(
  firstName: string,
  creditAmount: number,
): string {
  return (
    `Bienvenue sur la plateforme, ${firstName} ! 🎉\n` +
    `\n` +
    `Votre numéro WhatsApp a bien été vérifié et votre profil est maintenant activé.\n` +
    `\n` +
    `Vous avez reçu un crédit de bienvenue de *${creditAmount} FCFA* dans votre portefeuille 🎁\n` +
    `\n` +
    `Vous pouvez maintenant :\n` +
    `• Consulter les opportunités disponibles\n` +
    `• Postuler à une offre d'emploi\n` +
    `• Utiliser votre crédit pour vos prochaines actions\n` +
    `\n` +
    `Solde actuel : *${creditAmount} FCFA*\n` +
    `\n` +
    `Tapez *MENU* pour commencer.`
  );
}
