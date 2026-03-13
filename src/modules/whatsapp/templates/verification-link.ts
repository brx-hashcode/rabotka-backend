export function verificationLinkMessage(link: string): string {
  return [
    'Pour vérifier votre compte WhatsApp, cliquez sur le lien ci-dessous :',
    '',
    link,
    '',
    `Si vous nêtes pas à l'origine de cette demande, vous pouvez ignorer ce message.`,
  ].join('\n');
}
