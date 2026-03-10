export function paymentLinkMessage(firstName: string, paymentUrl: string): string {
  return `Bonjour ${firstName},\n\nVotre lien de paiement est prêt. Cliquez sur le lien ci-dessous pour procéder au paiement et activer votre compte :\n\n${paymentUrl}\n\nCe lien est personnel et sécurisé. Merci de compléter votre paiement pour accéder à toutes les fonctionnalités de Rabotka.`;
}
