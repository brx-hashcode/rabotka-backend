export function whatsappVerifyPromptMessage(firstName: string): string {
  return [
    `🎉 *Votre profil a été approuvé, ${firstName} !*`,
    ``,
    `Notre équipe a validé votre inscription. Il ne vous reste plus qu'une étape : activer votre compte WhatsApp.`,
    ``,
    `👉 Tapez *VERIFIER* pour finaliser votre inscription et accéder à toutes les fonctionnalités.`,
    ``,
    `_Vous pouvez aussi cliquer sur le lien qui vous a été envoyé._`,
  ].join('\n');
}

export function whatsappAlreadyVerifiedMessage(): string {
  return [
    `✅ *Votre numéro WhatsApp est déjà vérifié.*`,
    ``,
    `Tapez *MENU* pour accéder à la plateforme.`,
  ].join('\n');
}
