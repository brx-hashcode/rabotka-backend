function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatAccountActivatedMessage(params: {
  firstName: string;
  profileType: 'WORKER' | 'EMPLOYER';
}): string {
  const typeLabel = params.profileType === 'WORKER' ? 'Worker' : 'Employer';
  const workerActions = [
    "*Consulter les offres d'emploi disponibles*",
    '*Postuler aux offres qui vous intéressent*',
    '*Gérer vos candidatures*',
  ];
  const employerActions = [
    "*Publier des offres d'emploi*",
    '*Recevoir des candidatures*',
    '*Gérer vos offres*',
  ];
  const actions =
    params.profileType === 'WORKER' ? workerActions : employerActions;

  return [
    `Felicitations ${params.firstName} !`,
    '',
    'Votre compte Rabotka a été activé avec succès !',
    '',
    `*Type de compte*: ${typeLabel}`,
    '*Statut*: Actif',
    '',
    '*Vous pouvez maintenant* :',
    '',
    ...actions.map((a) => `• ${a}`),
    '',
    '*Pour commencer, tapez "Menu" pour voir toutes les options disponibles.*',
    '',
    '*BIENVENUE SUR RABOTKA ! 🚀*',
  ].join('\n');
}

export function formatReminder24h(params: {
  offerTitle: string;
  scheduledAt: Date;
  address: string;
  amount: number;
  employerName: string;
  employerPhone: string;
  penaltyFcfa: number;
  thresholdHours: number;
}): string {
  return [
    '*RAPPEL - MISSION DEMAIN*',
    '',
    '*Vous avez une mission prévue demain* :',
    '',
    `*Offre*: ${params.offerTitle}`,
    `*Date*: ${formatDate(params.scheduledAt)} (demain matin)`,
    `*Adresse*: ${params.address}`,
    '',
    `*Rémunération*: ${params.amount.toLocaleString('fr-FR')} FCFA`,
    '',
    `*Employeur*: ${params.employerName}`,
    `*Contact*: ${params.employerPhone}`,
    '',
    '*IMPORTANT*:',
    `*Toute annulation < ${params.thresholdHours}h = pénalité de ${params.penaltyFcfa.toLocaleString('fr-FR')} FCFA*`,
    '*Soyez ponctuel pour maintenir votre score*',
    '',
    'Actions:',
    '1️⃣ Confirmer ma présence',
    '2️⃣ Annuler (sans pénalité pour le moment)',
    "3️⃣ Contacter l'employeur",
    '',
    'Tapez le numéro correspondant.',
  ].join('\n');
}

export function formatReminder2h(params: {
  offerTitle: string;
  scheduledAt: Date;
  address: string;
  employerName: string;
  employerPhone: string;
}): string {
  return [
    '*Votre mission commence dans 2 heures !*',
    '',
    `*Offre*: ${params.offerTitle}`,
    `*Date*: Aujourd'hui à ${params.scheduledAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
    `*Adresse*: ${params.address}`,
    '',
    `*Employeur*: ${params.employerName}`,
    `*Contact*: ${params.employerPhone}`,
    '',
    "*Dernier délai d'annulation sans pénalité dépassé.*",
    '',
    '*CONSEILS*:',
    '*✓ Prévoyez votre trajet*',
    '✓ Vérifiez que vous avez tout votre matériel',
    '✓ Arrivez 5-10 minutes en avance',
    '',
    '*BONNE MISSION ! 💪*',
  ].join('\n');
}
