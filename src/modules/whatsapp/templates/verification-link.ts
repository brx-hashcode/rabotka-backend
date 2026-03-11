export function verificationLinkMessage(
  firstName: string,
  link: string,
): string {
  return [
    `Bonjour ${firstName} 👋`,
    '',
    'Pour vérifier votre compte WhatsApp sur *Rabotka*, cliquez sur le lien ci-dessous :',
    '',
    `${link}`,
    '',
    '⏱️ Ce lien est sécurisé et expirera dans *30 minutes*.',
    `Si vous nêtes pas à l'origine de cette demande, vous pouvez ignorer ce message.`,
  ].join('\n');
}
