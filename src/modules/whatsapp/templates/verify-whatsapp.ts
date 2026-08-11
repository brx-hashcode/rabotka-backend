export function whatsappVerifyPromptMessage(firstName: string): string {
  return [
    `🎉 *Votre profil a été approuvé, ${firstName} !*`,
    ``,
    `Notre équipe a validé votre inscription. Il ne vous reste plus qu'une étape : activer votre compte WhatsApp.`,
    ``,
    // Was "Tapez *VERIFIER*", which the bot has never recognised: the only
    // command sets are CMD_MENU and CMD_PAY, and neither contains it. What
    // actually activates a KYC-approved account is any CMD_MENU word, so this
    // now names the one people reach for.
    `👉 Envoyez */* pour finaliser votre inscription et accéder à toutes les fonctionnalités.`,
    ``,
    `_Vous pouvez aussi cliquer sur le lien qui vous a été envoyé._`,
  ].join('\n');
}

export function whatsappAlreadyVerifiedMessage(): string {
  return [
    `✅ *Votre numéro WhatsApp est déjà vérifié.*`,
    ``,
    ``,
  ].join('\n');
}
