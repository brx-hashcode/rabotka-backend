import { SEP } from './application.messages';

function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
): string {
  const lines = [
    '*HISTORIQUE DES PÉNALITÉS*',
    '',
    '*RÉCAPITULATIF*',
    SEP,
    `*Total pénalités*: ${totalAmount.toLocaleString('fr-FR')} FCFA`,
    `*Nombre d'annulations tardives*: ${lateCancellationsCount}`,
    `*Score actuel*: ${currentScore}/100`,
    `*Missions complétées*: ${completedMissions}`,
    SEP,
    '',
  ];

  if (penalties.length === 0) {
    lines.push('Aucune pénalité enregistrée.', '');
  } else {
    lines.push('📅 Détails des pénalités:', '', SEP);
    for (const p of penalties) {
      lines.push(
        `📅 ${formatDate(p.appliedAt)}`,
        p.jobOfferTitle ? `*Offre*: ${p.jobOfferTitle}` : '',
        `*Pénalité*: ${p.amount.toLocaleString('fr-FR')} FCFA`,
        p.reason ? `*Raison*: ${p.reason}` : '',
        SEP,
        '',
      );
    }
  }

  lines.push(
    '*CONSEILS POUR AMÉLIORER VOTRE SCORE*',
    '✓ Complétez vos missions sans annulation',
    '✓ Maintenez un score > 90 pour plus de visibilité',
    '✓ Annulez toujours > 4h avant si nécessaire',
    '',
    "Tapez 'Menu' pour revenir.",
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
  const since = params.memberSince.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const activeOffers = params.activeOffersCount ?? params.offersCount;
  const balance = params.walletBalance ?? 0;
  return [
    `*VOTRE PROFIL RABOTKA*`,
    '',
    `*Nom*: ${params.lastName}`,
    `*Prénom*: ${params.firstName}`,
    `*Email*: ${params.email}`,
    '',
    '*Statistiques*',
    SEP,
    `*Membre depuis*: ${since}`,
    `*Offres publiées*: ${params.offersCount}`,
    `*Offres actives*: ${activeOffers}`,
    `*Candidatures en attente*: ${params.pendingCandidaturesCount}`,
    `*Solde portefeuille*: ${balance.toLocaleString('fr-FR')} FCFA`,
    SEP,
    '',
    '*Actions*',
    '1- Voir mes offres',
    '2- Candidatures reçues',
    '3- Retour au menu',
    '',
    'Tapez le numéro correspondant.',
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
  const since = params.memberSince.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const balance = params.walletBalance ?? 0;
  return [
    `*VOTRE PROFIL RABOTKA*`,
    '',
    `*Nom*: ${params.lastName}`,
    `*Prénom*: ${params.firstName}`,
    `*Email*: ${params.email}`,
    '',
    '*STATISTIQUES GÉNÉRALES*:',
    SEP,
    `*Score de fiabilité*: ${score}/100`,
    `*Membre depuis*: ${since}`,
    `*Missions complétées*: ${params.completedMissions}`,
    `*Revenus totaux*: ${params.totalEarnings.toLocaleString('fr-FR')} FCFA`,
    `*Taux de complétion*: ${params.completionRate}%`,
    `*Solde portefeuille*: ${balance.toLocaleString('fr-FR')} FCFA`,
    SEP,
    '',
    '*PÉNALITÉS*:',
    `*Total pénalités*: ${params.totalPenalties.toLocaleString('fr-FR')} FCFA`,
    `*Annulations tardives*: ${params.lateCancellations}`,
    '',
    '*ACTIONS*:',
    "1- Voir l'historique complet",
    '2- Historique des pénalités',
    '3- Retour au menu',
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatPenaltyBlocked(
  totalAmount: number,
  mtnNumber: string,
  airtelNumber: string,
): string {
  return [
    '⛔ *Candidature bloquée — pénalité impayée*',
    '',
    `Vous avez *${totalAmount.toLocaleString('fr-FR')} FCFA* de pénalités impayées.`,
    "Vous ne pouvez pas postuler tant qu'elles ne sont pas réglées.",
    '',
    '*Comment payer :*',
    `MTN Money : *${mtnNumber}*`,
    `Airtel Money : *${airtelNumber}*`,
    '',
    'Indiquez votre numéro de téléphone en référence lors du paiement.',
    'Votre compte sera débloqué sous 24h après réception.',
    '',
    'Tapez *profil* pour voir le détail ou *menu* pour revenir.',
  ].join('\n');
}

export function formatCancelApplicationNoPenalty(params: {
  offerTitle: string;
  scheduledAt: Date;
  amount: number;
  timeRemaining: string;
}): string {
  return [
    '*Annulation de candidature*',
    '',
    `Offre: ${params.offerTitle}`,
    `Date: ${formatDate(params.scheduledAt)}`,
    `Montant: ${params.amount.toLocaleString('fr-FR')} FCFA`,
    `Temps restant: ${params.timeRemaining}`,
    '',
    'Aucune pénalité ne sera appliquée (annulation > 4h avant).',
    '',
    'Souhaitez-vous indiquer une raison ? (optionnel)',
    '',
    "1- Confirmer l'annulation sans raison",
    '   ou tapez votre raison directement et envoyez',
    '2- Retour à la candidature',
    '3- Menu',
    '',
    '*0 ou 1 – Confirmer sans raison | 2 – Annuler*',
  ].join('\n');
}

export function formatPenaltyReminderDay(params: {
  firstName: string;
  amount: number;
  dayNumber: number;
  totalUnpaid: number;
}): string {
  const { firstName, amount, dayNumber, totalUnpaid } = params;
  const amountStr = amount.toLocaleString('fr-FR');
  const totalStr = totalUnpaid.toLocaleString('fr-FR');

  const urgencyLines: Record<number, string[]> = {
    1: [
      `Bonjour ${firstName}, vous avez une pénalité impayée de *${amountStr} FCFA* sur Rabotka.`,
      '',
      'Réglez cette pénalité pour continuer à postuler aux offres et publier.',
    ],
    2: [
      `⚠️ *Rappel (Jour 2)* — Bonjour ${firstName}, votre pénalité de *${amountStr} FCFA* est toujours impayée.`,
      '',
      'Vous avez encore *1 jour* pour régler avant le blocage complet de votre compte.',
    ],
    3: [
      `⚠️ *Dernier avertissement* — Bonjour ${firstName}.`,
      '',
      `Votre pénalité de *${amountStr} FCFA* n'a pas été réglée depuis ${dayNumber} jours.`,
      '',
      '*Votre compte sera bloqué dans moins de 24h.* Vous ne pourrez plus postuler, publier des offres ni débloquer des contacts.',
    ],
  };

  const header = urgencyLines[dayNumber] ?? urgencyLines[1];
  const totalLine =
    totalUnpaid !== amount ? [`*Total impayé*: ${totalStr} FCFA`, ''] : [];

  return [
    ...header,
    ...totalLine,
    '',
    '*Comment payer :*',
    'Tapez *PAYER* pour régler vos pénalités directement depuis le bot.',
    '',
    'Tapez *PROFIL* pour voir le détail de vos pénalités.',
  ].join('\n');
}

export function formatPenaltyPaidSuccess(firstName: string): string {
  return [
    `✅ *Paiement confirmé* — Merci ${firstName} !`,
    '',
    'Vos pénalités ont été réglées. Votre compte est maintenant *débloqué*.',
    '',
    'Vous pouvez à nouveau postuler aux offres et publier.',
    '',
    'Tapez *MENU* pour continuer.',
  ].join('\n');
}

export function formatCancelApplicationWithPenalty(params: {
  offerTitle: string;
  scheduledAt: Date;
  amount: number;
  timeRemaining: string;
  penaltyAmount: number;
  scoreDeduction: number;
  newScore: number;
}): string {
  return [
    '*ATTENTION - Annulation tardive*',
    '',
    `Offre: ${params.offerTitle}`,
    `Date: ${formatDate(params.scheduledAt)} (AUJOURDHUI)`,
    `Montant: ${params.amount.toLocaleString('fr-FR')} FCFA`,
    `Temps restant: ${params.timeRemaining}`,
    '',
    '*Pénalité appliquée*',
    `Montant: ${params.penaltyAmount.toLocaleString('fr-FR')} FCFA`,
    `Impact score: -${params.scoreDeduction} points`,
    `Nouveau score: ${params.newScore}/100`,
    '',
    'Cette pénalité sera déduite de vos prochaines missions.',
    '',
    "Raison de l'annulation ? (obligatoire pour annulation tardive).",
    '',
    '*Tapez votre raison.*',
  ].join('\n');
}
