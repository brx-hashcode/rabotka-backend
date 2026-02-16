export function accountActivatedMessage(
  firstName: string,
  profileType: 'WORKER' | 'EMPLOYER',
): string {
  const typeLabel = profileType === 'WORKER' ? 'Worker' : 'Employer';
  const workerActions = [
    "📋 Consulter les offres d'emploi disponibles",
    '✋ Postuler aux offres qui vous intéressent',
    '💼 Gérer vos candidatures',
  ];
  const employerActions = [
    "📝 Publier des offres d'emploi",
    '👥 Recevoir des candidatures',
    '📊 Gérer vos offres',
  ];
  const actions = profileType === 'WORKER' ? workerActions : employerActions;

  return [
    `🎉 Félicitations ${firstName} !`,
    '',
    'Votre compte Rabotka a été activé avec succès !',
    '',
    `✅ Type de compte : ${typeLabel}`,
    '✅ Statut : Actif',
    '',
    'Vous pouvez maintenant :',
    '',
    ...actions.map((a) => `• ${a}`),
    '',
    'Pour commencer, tapez "Menu" pour voir toutes les options disponibles.',
    '',
    'Bienvenue dans la communauté Rabotka ! 🚀',
  ].join('\n');
}
