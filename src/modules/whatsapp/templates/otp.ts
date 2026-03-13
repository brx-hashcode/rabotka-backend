export function otpMessage(code: string): string {
  return [
    `Voici votre code de vérification : ${code}`,
    '',
    'Ce code est valide pendant 5 minutes.',
  ].join('\n');
}
