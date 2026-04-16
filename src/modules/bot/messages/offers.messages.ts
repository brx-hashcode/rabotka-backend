const SEP = '━━━━━━━━━━━━━━━━━━';

export type OfferListItem = {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  note: string | null;
  quantity?: number;
  acceptedCount?: number;
  status: string;
  employerScore?: number | null;
};

/** Map job-offer detail / list API shape to OfferListItem for bot formatters. */
export function jobOfferToOfferListItem(offer: {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount?: number;
  status: string;
  employer?: { reliability_score?: number | null } | null;
}): OfferListItem {
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    scheduled_at: offer.scheduled_at,
    amount: offer.amount,
    payment_flow: offer.payment_flow,
    address: offer.address,
    note: offer.note,
    quantity: offer.quantity,
    acceptedCount: offer.acceptedCount ?? 0,
    status: offer.status,
    employerScore: offer.employer?.reliability_score ?? null,
  };
}

export function formatPaymentFlow(flow: string | null): string {
  if (!flow) return '';
  const map: Record<string, string> = {
    HOURLY: 'par heure',
    DAILY: 'par jour',
    MONTHLY: 'par mois',
  };
  return map[flow] ?? flow;
}

function formatAmount(amount: number | null, flow: string | null): string {
  if (amount == null) return 'Prix à négocier';
  const flowLabel = formatPaymentFlow(flow);
  const flowSuffix = flowLabel ? ` ${flowLabel}` : '';
  return `${amount.toLocaleString('fr-FR')} FCFA${flowSuffix}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatOfferList(
  offers: OfferListItem[],
  total: number,
  pageInfo?: { hasNext: boolean },
): string {
  const lines = [`*OFFRES DISPONIBLES (${total} offres)*`, '', SEP];

  for (const o of offers) {
    const summary =
      o.description.length > 60
        ? o.description.slice(0, 60) + '...'
        : o.description;
    lines.push(
      `*Offre #${o.id.slice(0, 8)}*`,
      o.title,
      '',
      `*Résumé*: ${summary}`,
      `*Date*: ${formatDate(o.scheduled_at)}`,
      `*Montant*: ${formatAmount(o.amount, o.payment_flow)}`,
      `*Adresse*: ${o.address.length > 40 ? o.address.slice(0, 40) + '...' : o.address}`,
      '',
      '1️⃣ Postuler',
      '2️⃣ Voir détails',
      SEP,
      '',
    );
  }

  if (pageInfo?.hasNext) {
    lines.push('3️⃣ *Offre suivante*');
  }
  lines.push('4️⃣ *Retour au menu*', '', '*Tapez le numéro correspondant.*');

  return lines.join('\n');
}

/** Compact numbered list for list-offers flow: two lines per offer, 1-5 select, 6 Voir plus, 7 Menu */
export function formatOfferListCompact(
  offers: OfferListItem[],
  hasMore: boolean,
): string {
  const lines = ['*OFFRES DISPONIBLES*', ''];
  offers.forEach((o, i) => {
    const num = i + 1;
    const qty = o.quantity ?? 1;
    const filled = o.acceptedCount ?? 0;
    const remaining = Math.max(0, qty - filled);
    let spotsLabel: string;
    if (remaining === 0) {
      spotsLabel = '🔴 Complet';
    } else if (remaining === qty) {
      const placeSuffix = qty > 1 ? 's' : '';
      spotsLabel = `🟢 ${qty} place${placeSuffix}`;
    } else {
      const restanteSuffix = remaining > 1 ? 's' : '';
      spotsLabel = `🟡 ${remaining}/${qty} restante${restanteSuffix}`;
    }
    const shortAddr =
      o.address.length > 40 ? o.address.slice(0, 40) + '…' : o.address;
    lines.push(
      `${num}- *${o.title}*`,
      `    • 💰 Montant : ${formatAmount(o.amount, o.payment_flow)}`,
      `    • 📅 Date : ${formatDate(o.scheduled_at)}`,
      `    • 👥 Places : ${spotsLabel}`,
      `    • 📍 Adresse : ${shortAddr}`,
      '',
    );
  });
  lines.push('');
  if (hasMore) {
    lines.push(
      `${offers.length + 1} - Voir plus`,
      '',
      `Tapez un numéro (1-${offers.length}) pour sélectionner une offre, ${offers.length + 1} pour voir plus, ou *Menu* pour revenir au menu.`,
    );
  } else {
    lines.push(
      'Tapez un numéro pour sélectionner une offre ou *Menu* pour revenir au menu.',
    );
  }
  return lines.join('\n');
}

export function formatOfferDetail(offer: OfferListItem): string {
  const lines = [
    `*OFFRE #${offer.id.slice(0, 8)} - DÉTAILS COMPLETS*`,
    '',
    `*Titre*: ${offer.title}`,
    '',
    '*Description complète*:',
    offer.description,
    '',
    `*Date et heure*: ${formatDate(offer.scheduled_at)}`,
    `*Rémunération*: ${formatAmount(offer.amount, offer.payment_flow)}`,
    `*Personnes requises*: ${offer.quantity ?? 1}`,
    `*Adresse*: ${offer.address}`,
    '',
  ];
  if (offer.note) {
    lines.push(`*Note de l'employeur*:`, offer.note, '');
  }
  lines.push(
    "*Employeur*: [Masqué jusqu'à acceptation]",
    '',
    'Actions:',
    '1️⃣ Postuler à cette offre',
    '2️⃣ Retour à la liste',
    '',
    'Tapez le numéro correspondant.',
  );
  return lines.join('\n');
}

function employerScoreStar(score: number): string {
  if (score >= 90) return '⭐⭐⭐';
  if (score >= 75) return '⭐⭐';
  if (score >= 60) return '⭐';
  return '⚠️';
}

function formatEmployerScore(score: number | null | undefined): string {
  if (score == null) return '';
  return `*Fiabilité employeur*: ${score}/100 ${employerScoreStar(score)}`;
}

/** Single offer view in list-offers flow with 4 actions */
export function formatOfferDetailWithActions(offer: OfferListItem): string {
  const summary =
    offer.description.length > 80
      ? offer.description.slice(0, 80) + '...'
      : offer.description;
  const scoreLine = formatEmployerScore(offer.employerScore);
  return [
    `*OFFRE - ${offer.title}*`,
    '',
    `*Résumé*: ${summary}`,
    `*Date*: ${formatDate(offer.scheduled_at)}`,
    `*Montant*: ${formatAmount(offer.amount, offer.payment_flow)}`,
    `*Places disponibles*: ${Math.max(0, (offer.quantity ?? 1) - (offer.acceptedCount ?? 0))}/${offer.quantity ?? 1}`,
    `*Adresse*: ${offer.address.slice(0, 50)}${offer.address.length > 50 ? '...' : ''}`,
    ...(scoreLine ? [scoreLine] : []),
    '',
    SEP,
    '',
    '1️⃣ *Postuler*',
    '2️⃣ *Voir description complète*',
    '3️⃣ *Retour à la liste des offres*',
    "4️⃣ *Menu* (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatOfferPublishedSuccess(offerId: string): string {
  return [
    '*Votre offre a été publiée avec succès !*',
    'Elle est maintenant visible par tous les workers.',
    '',
    `*Offre ID*: #${offerId.slice(0, 8)}`,
    "Vous recevrez une notification dès qu'un worker postulera.",
    '',
    "Tapez 'Menu' pour revenir au menu principal.",
  ].join('\n');
}

export function formatNoOffersAvailable(): string {
  return "Aucune offre disponible pour le moment. Tapez 'Menu' pour revenir.";
}
