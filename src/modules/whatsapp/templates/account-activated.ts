export function accountActivatedMessage(
  firstName: string,
  profileType: 'WORKER' | 'EMPLOYER',
): string {
  const workerActions = [
    "Consulter les offres d'emploi disponibles",
    'Postuler aux offres qui vous intéressent',
    'Suivre et gérer vos candidatures',
  ];

  const employerActions = [
    "Publier des offres d'emploi",
    'Recevoir des candidatures',
    'Gérer vos offres et recruter',
  ];

  const actions = profileType === 'WORKER' ? workerActions : employerActions;

  return [
    `Félicitations ${firstName} !`,
    '',
    'Votre compte *Rabotka* est maintenant activé.',
    '',
    'Vous pouvez maintenant :',
    '',
    ...actions.map((a) => `• ${a}`),
    '',
    '',
    '',
    'Bienvenue dans la communauté Rabotka 🚀',
  ].join('\n');
}
