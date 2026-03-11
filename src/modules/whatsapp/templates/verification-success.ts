export function verificationSuccessMessage(firstName: string): string {
  return [
    `Bonjour ${firstName} 👋`,
    '',
    '✅ Votre compte WhatsApp a été vérifié avec succès.',
    '',
    'Vous pouvez maintenant accéder à toutes les fonctionnalités de *Rabotka*.',
    '',
    '👉 Tapez *Menu* pour commencer.',
  ].join('\n');
}
