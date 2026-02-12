export function verificationLinkMessage(
  firstName: string,
  link: string,
): string {
  return `Bonjour ${firstName},

Cliquez sur ce lien pour vérifier votre compte WhatsApp :
${link}

Ce lien expire dans 30 minutes.`;
}
