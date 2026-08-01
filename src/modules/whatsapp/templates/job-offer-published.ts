export function jobOfferPublishedMessage(
  firstName: string,
  jobTitle: string,
): string {
  return [
    `Félicitations ${firstName} 🎉`,
    '',
    `Votre offre d'emploi *${jobTitle}* a été publiée avec succès.`,
    '',
    'Elle est maintenant visible par les travailleurs sur la plateforme.',
    '',
    '',
  ].join('\n');
}
