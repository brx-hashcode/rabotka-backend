
function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function fcfa(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

export type PenaltyItem = {
  id: string;
  amount: number;
  reason: string | null;
  appliedAt: Date;
  jobOfferTitle?: string;
};

export function formatPenaltyHistory(
  penalties: PenaltyItem[],
  totalAmount: number,
  lateCancellationsCount: number,
  currentScore: number,
  completedMissions: number,
  thresholdHours: number,
): string {
  const lines = [
    '*Historique des pénalités*',
    '',
    '*Récapitulatif*',
    `*Total penalites*: ${fcfa(totalAmount)}`,
    `*Annulations tardives*: ${lateCancellationsCount}`,
    `*Score actuel*: ${currentScore}/100`,
    `*Missions completees*: ${completedMissions}`,
    '',
  ];

  if (penalties.length === 0) {
    lines.push('Aucune pénalité enregistrée.', '');
  } else {
    lines.push('Détail des pénalités :', '');
    for (const p of penalties) {
      lines.push(
        `Date : ${formatDate(p.appliedAt)}`,
        p.jobOfferTitle ? `*Offre*: ${p.jobOfferTitle}` : '',
        `*Penalite*: ${fcfa(p.amount)}`,
        p.reason ? `*Raison*: ${p.reason}` : '',
        '',
      );
    }
  }

  lines.push(
    '*Conseils pour améliorer votre score*',
    `- Completez vos missions sans annulation`,
    `- Maintenez un score > 90 pour plus de visibilite`,
    `- Annulez toujours plus de ${thresholdHours}h avant si necessaire`,
    '',
    "Tapez *Menu* pour revenir.",
  );
  return lines.join('\n');
}

export function formatEmployerProfileStats(params: {
  firstName: string;
  lastName: string;
  email: string;
  memberSince: Date;
  offersCount: number;
  pendingCandidaturesCount: number;
  activeOffersCount?: number;
  walletBalance?: number;
}): string {
  const since = formatDateShort(params.memberSince);
  const activeOffers = params.activeOffersCount ?? params.offersCount;
  const balance = params.walletBalance ?? 0;
  return [
    '*Votre profil Rabotka*',
    '',
    `*Nom*: ${params.lastName}`,
    `*Prenom*: ${params.firstName}`,
    `*Email*: ${params.email}`,
    '',
    '*Statistiques*',
    '',
    `*Membre depuis*: ${since}`,
    `*Offres publiees*: ${params.offersCount}`,
    `*Offres actives*: ${activeOffers}`,
    `*Candidatures en attente*: ${params.pendingCandidaturesCount}`,
    `*Solde portefeuille*: ${fcfa(balance)}`,
    '',
    '',
    '*Actions*',
    '1- Voir mes offres',
    '2- Candidatures recues',
    '3- Retour au menu',
    '',
    'Tapez le numero correspondant.',
  ].join('\n');
}

export function formatProfileStats(params: {
  firstName: string;
  lastName: string;
  email: string;
  reliabilityScore: number | null;
  memberSince: Date;
  completedMissions: number;
  totalEarnings: number;
  completionRate: number;
  totalPenalties: number;
  lateCancellations: number;
  walletBalance?: number;
}): string {
  const score = params.reliabilityScore ?? 100;
  const since = formatDateShort(params.memberSince);
  const balance = params.walletBalance ?? 0;
  return [
    '*Votre profil Rabotka*',
    '',
    `*Nom*: ${params.lastName}`,
    `*Prenom*: ${params.firstName}`,
    `*Email*: ${params.email}`,
    '',
    '*Statistiques générales*',
    '',
    `*Score de fiabilite*: ${score}/100`,
    `*Membre depuis*: ${since}`,
    `*Missions completees*: ${params.completedMissions}`,
    `*Revenus totaux*: ${fcfa(params.totalEarnings)}`,
    `*Taux de completion*: ${params.completionRate}%`,
    `*Solde portefeuille*: ${fcfa(balance)}`,
    '',
    '',
    '*Pénalités*',
    `*Total penalites*: ${fcfa(params.totalPenalties)}`,
    `*Annulations tardives*: ${params.lateCancellations}`,
    '',
    '*Actions*',
    "1- Voir l'historique complet",
    '2- Historique des penalites',
    '3- Retour au menu',
    '',
    '*Tapez le numero correspondant.*',
  ].join('\n');
}

export function formatPenaltyBlocked(
  totalAmount: number,
  mtnNumber: string,
  airtelNumber: string,
): string {
  return [
    '*Candidature bloquée — pénalité impayée*',
    '',
    `Vous avez *${fcfa(totalAmount)}* de pénalités impayées.`,
    "Vous ne pouvez pas postuler tant qu'elles ne sont pas reglees.",
    '',
    '*Comment payer :*',
    `MTN Money : *${mtnNumber}*`,
    `Airtel Money : *${airtelNumber}*`,
    '',
    'Indiquez votre numero de telephone en reference lors du paiement.',
    'Votre compte sera debloque sous 24h apres reception.',
    '',
    "Tapez *Menu* puis *5* (Mon profil) pour voir le detail ou 'Menu' pour revenir.",
  ].join('\n');
}

export function formatCancelApplicationNoPenalty(params: {
  offerTitle: string;
  scheduledAt: Date;
  amount: number | null;
  timeRemaining: string;
  thresholdHours: number;
}): string {
  const threshold = params.thresholdHours;
  const montant =
    params.amount && params.amount > 0 ? fcfa(params.amount) : 'A negocier';
  return [
    '*Annulation de candidature*',
    '',
    `*Offre*: ${params.offerTitle}`,
    `*Date*: ${formatDate(params.scheduledAt)}`,
    `*Montant*: ${montant}`,
    `*Temps restant*: ${params.timeRemaining}`,
    '',
    `Aucune pénalité — annulation effectuée plus de ${threshold}h avant.`,
    '',
    'Souhaitez-vous indiquer une raison ? (optionnel)',
    '',
    "1- Confirmer l'annulation sans raison",
    '   ou tapez votre raison et envoyez directement',
    '2- Retour a la candidature',
    '3- Menu',
    '',
    '*Tapez le numero correspondant.*',
  ].join('\n');
}

export function formatPenaltyReminderDay(params: {
  firstName: string;
  amount: number;
  dayNumber: number;
  totalUnpaid: number;
  daysUntilBlock?: number;
}): string {
  const { firstName, amount, dayNumber, totalUnpaid } = params;
  const daysUntilBlock = params.daysUntilBlock ?? Math.max(0, 3 - dayNumber);

  const urgencyLines: Record<number, string[]> = {
    1: [
      `Bonjour ${firstName}, vous avez une penalite impayee de *${fcfa(amount)}* sur Rabotka.`,
      '',
      'Reglez cette penalite pour continuer a postuler aux offres et publier.',
    ],
    2: [
      `*Rappel (Jour ${dayNumber})* — Bonjour ${firstName}, votre penalite de *${fcfa(amount)}* est toujours impayee.`,
      '',
      `Vous avez encore *${daysUntilBlock} jour(s)* pour regler avant le blocage complet de votre compte.`,
    ],
    3: [
      `*Dernier avertissement* — Bonjour ${firstName}.`,
      '',
      `Votre penalite de *${fcfa(amount)}* n'a pas ete reglee depuis ${dayNumber} jours.`,
      '',
      '*Votre compte sera bloque dans moins de 24h.* Vous ne pourrez plus postuler, publier des offres ni debloquer des contacts.',
    ],
  };

  const header = urgencyLines[dayNumber] ?? urgencyLines[1];
  const totalLine =
    totalUnpaid !== amount ? [`*Total impaye*: ${fcfa(totalUnpaid)}`, ''] : [];

  return [
    ...header,
    ...totalLine,
    '',
    '*Comment payer :*',
    'Tapez *3* (Paiements en attente) pour régler vos pénalités.',
    '',
    'Tapez *5* (Mon profil) pour voir le détail de vos pénalités.',
  ].join('\n');
}

export function formatPenaltyPaidSuccess(firstName: string): string {
  return [
    `*Paiement confirme* — Merci ${firstName} !`,
    '',
    'Vos penalites ont ete reglees. Votre compte est maintenant *debloque*.',
    '',
    'Vous pouvez a nouveau postuler aux offres et publier.',
    '',
    'Tapez "MENU" pour continuer.',
  ].join('\n');
}

export function formatCancelApplicationWithPenalty(params: {
  offerTitle: string;
  scheduledAt: Date;
  amount: number | null;
  timeRemaining: string;
  penaltyAmount: number;
  scoreDeduction: number;
  newScore: number;
}): string {
  const montant =
    params.amount && params.amount > 0 ? fcfa(params.amount) : 'A negocier';
  return [
    '*ATTENTION - Annulation tardive*',
    '',
    `*Offre*: ${params.offerTitle}`,
    `*Date mission*: ${formatDate(params.scheduledAt)}`,
    `*Montant*: ${montant}`,
    `*Temps restant*: ${params.timeRemaining}`,
    '',
    '',
    '',
    '*Pénalité applicable*',
    `*Montant*: ${fcfa(params.penaltyAmount)}`,
    `*Impact score*: -${params.scoreDeduction} points`,
    `*Nouveau score*: ${params.newScore}/100`,
    '',
    '',
    '',
    "Raison de l'annulation ? (obligatoire pour annulation tardive)",
    '',
    '*Tapez votre raison.*',
  ].join('\n');
}
