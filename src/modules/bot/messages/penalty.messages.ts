function formatDate(d: Date | null): string {
  // CDI/CDD/STAGE offers carry no closing date, and a penalty message still
  // has to print something.
  if (!d) return 'Non précisée';
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

export type CompletedMissionItem = {
  title: string;
  scheduled_at: Date;
  amount: number | null;
};

export function formatCancelApplicationNoPenalty(params: {
  offerTitle: string;
  scheduledAt: Date | null;
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
    '3- Quitter',
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
    'Tapez *payer* pour régler vos pénalités.',
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
    '',
  ].join('\n');
}

export function formatCancelApplicationWithPenalty(params: {
  offerTitle: string;
  scheduledAt: Date | null;
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
