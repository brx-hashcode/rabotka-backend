export function paymentUseRegisteredNumberPrompt(phone: string): string {
  return [
    `💳 *Paiement Mobile Money*`,
    ``,
    `Voulez-vous payer avec votre numéro enregistré ?`,
    `📱 *${phone}*`,
    ``,
    `1 — Oui, utiliser ce numéro`,
    `2 — Non, utiliser un autre numéro`,
    `3 — Payer via le lien web`,
  ].join('\n');
}

export function paymentEnterPhonePrompt(): string {
  return [
    `📱 *Entrez le numéro Mobile Money*`,
    ``,
    `Saisissez le numéro à débiter (avec l'indicatif pays) :`,
    `Exemple : *242XXXXXXXX*`,
  ].join('\n');
}

export function paymentChooseOperatorPrompt(): string {
  return [
    `📶 *Choisissez votre opérateur*`,
    ``,
    `1 — MTN Mobile Money`,
    `2 — Airtel Money`,
  ].join('\n');
}

export function paymentPendingMessage(
  amount: number,
  operator: string,
  phone: string,
): string {
  return [
    `⏳ *Paiement en cours…*`,
    ``,
    `Un paiement de *${amount.toLocaleString('fr-FR')} FCFA* va être déclenché sur le *${operator}* (*${phone}*).`,
    ``,
    `Vous allez recevoir une invitation de paiement sur votre téléphone. *Confirmez-la pour finaliser.*`,
    ``,
    `Tapez *MENU* pour revenir au menu principal.`,
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
