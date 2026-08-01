export function paymentUseRegisteredNumberPrompt(phone: string): string {
  return [
    `*Paiement Mobile Money*`,
    ``,
    `Voulez-vous payer avec votre numéro enregistré ?`,
    `*${phone}*`,
    ``,
    `1 - Oui, utiliser ce numéro`,
    `2 - Non, utiliser un autre numéro`,
    `3 - Payer via le lien web`,
  ].join('\n');
}

export function paymentEnterPhonePrompt(): string {
  return [
    `*Entrez le numéro Mobile Money*`,
    ``,
    `Saisissez le numéro à débiter (sans indicatif pays) :`,
    `Exemple : *06XXXXXXX* (MTN) ou *05XXXXXXX* / *04XXXXXXX* (Airtel)`,
  ].join('\n');
}

export function paymentPendingMessage(
  amount: number,
  operator: string,
  phone: string,
): string {
  return [
    `*Paiement en cours…*`,
    ``,
    `Un paiement de *${amount.toLocaleString('fr-FR')} FCFA* va être déclenché sur le *${operator}* (*${phone}*).`,
    ``,
    `Vous allez recevoir une invitation de paiement sur votre téléphone. *Confirmez-la pour finaliser.*`,
    ``,
    ``,
  ].join('\n');
}

export function paymentDirectFailedMessage(fallbackUrl: string): string {
  return [
    `❌ *Échec du déclenchement du paiement*`,
    ``,
    `Impossible de déclencher le paiement pour le moment. Veuillez réessayer ou payer via le lien ci-dessous :`,
    ``,
    fallbackUrl,
  ].join('\n');
}

export function paymentOperatorUnknownMessage(): string {
  return [
    `⚠️ *Opérateur non reconnu*`,
    ``,
    `Les numéros commençant par *06* sont MTN Mobile Money.`,
    `Les numéros commençant par *05* ou *04* sont Airtel Money.`,
    ``,
    `Veuillez entrer un numéro valide.`,
  ].join('\n');
}
