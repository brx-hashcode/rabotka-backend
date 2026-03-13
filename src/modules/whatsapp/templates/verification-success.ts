export function verificationSuccessMessage(firstName: string): string {
  return [
    `Bonjour ${firstName} 👋`,
    '',
    '✅ Votre numéro WhatsApp a été vérifié avec succès.',
    '',
    'Vous recevrez prochainement un lien pour activer votre compte Rabotka.',
    '',
    'Merci pour votre patience 🙏',
  ].join('\n');
}
