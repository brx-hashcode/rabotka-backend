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
    'Le détail de vos pénalités est dans l’application, sur votre profil.',
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
