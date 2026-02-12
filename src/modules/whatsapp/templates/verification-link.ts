export function verificationLinkMessage(
  firstName: string,
  link: string,
): string {
  return `Bonjour ${firstName},

Veuillez cliquer sur le lien ci-dessous pour vérifier votre compte WhatsApp :
${link}

Ce lien est valable pendant 30 minutes.`;
}
