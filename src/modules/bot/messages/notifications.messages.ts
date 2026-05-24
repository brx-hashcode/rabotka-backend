import { APP_TIMEZONE } from '../utils/parse-date-time';

export function formatKycValidatedMessage(
  firstName: string,
  _profileType: 'WORKER' | 'EMPLOYER',
): string {
  return [
    `Bonjour ${firstName},`,
    '',
    "Bonne nouvelle ! 🎉 Votre vérification d'identité (KYC) a été approuvée avec succès.",
    '',
    'Tapez *Menu* pour commencer',
  ].join('\n');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIMEZONE,
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
    '*Bienvenue sur Rabotka !*',
  ].join('\n');
}

export function formatReminder24h(params: {
  offerTitle: string;
  scheduledAt: Date;
  address: string;
  amount: number;
  employerName: string;
  employerPhone: string;
  cancellationThresholdHours: number;
  penaltyFcfa: number;
}): string {
  return [
    '*Rappel de mission*',
    '',
    'Votre mission est prévue demain.',
    '',
    `*Mission*: ${params.offerTitle}`,
    `*Date*: ${formatDate(params.scheduledAt)}`,
    `*Lieu*: ${params.address}`,
    `*Montant*: ${params.amount.toLocaleString('fr-FR')} FCFA`,
    '',
    `*Employeur*: ${params.employerName}`,
    `*Contact*: ${params.employerPhone}`,
    '',
    '*Important*',
    `• Annulation < ${params.cancellationThresholdHours}h : pénalité de ${params.penaltyFcfa.toLocaleString('fr-FR')} FCFA`,
    '• Soyez ponctuel pour garder un bon score',
    '',
    '1- Annuler ma candidature',
    '2- Je serai présent (ne rien faire)',
    '',
    'Répondez avec le numéro correspondant.',
  ].join('\n');
}

export function formatReminderStart(params: {
  offerTitle: string;
  scheduledAt: Date;
  address: string;
  employerName: string;
  employerPhone: string;
}): string {
  return [
    "*C'est l'heure — votre mission commence !*",
    '',
    `*Offre*: ${params.offerTitle}`,
    `*Heure*: ${params.scheduledAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE })}`,
    `*Adresse*: ${params.address}`,
    '',
    `*Employeur*: ${params.employerName}`,
    `*Contact*: ${params.employerPhone}`,
    '',
    '*Bonne mission ! Donnez le meilleur de vous-même 💪*',
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
    `*Date*: Aujourd'hui à ${params.scheduledAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE })}`,
    `*Adresse*: ${params.address}`,
    '',
    `*Employeur*: ${params.employerName}`,
    `*Contact*: ${params.employerPhone}`,
    '',
    "*Dernier délai d'annulation sans pénalité dépassé.*",
    '',
    '*Conseils*:',
    '✓ Prévoyez votre trajet',
    '✓ Vérifiez que vous avez tout votre matériel',
    '✓ Arrivez 5-10 minutes en avance',
    '',
    '*Bonne mission ! 💪*',
  ].join('\n');
}
