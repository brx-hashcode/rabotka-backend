export function otpMessage(code: string): string {
  return [
    `Bonjour 👋`,
    '',
    'Voici votre code de vérification Rabotka :',
    '',
    `${code}`,
    '',
    'Ce code est valide pendant 5 minutes. Ne le partagez avec personne.',
  ].join('\n');
}
