const SEP = '━━━━━━━━━━━━━━━━━━';

export type OfferListItem = {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  note: string | null;
  quantity?: number;
  acceptedCount?: number;
  status: string;
  employerScore?: number | null;
};

export function formatPaymentFlow(flow: string): string {
  const map: Record<string, string> = {
    HOURLY: 'par heure',
    DAILY: 'par jour',
    MONTHLY: 'par mois',
  };
  return map[flow] ?? flow;
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
      `*Montant*: ${o.amount.toLocaleString('fr-FR')} FCFA ${formatPaymentFlow(o.payment_flow)}`,
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
    const flowLabel = formatPaymentFlow(o.payment_flow);
    const qty = o.quantity ?? 1;
    const filled = o.acceptedCount ?? 0;
    const remaining = Math.max(0, qty - filled);
    const spotsLabel =
      remaining === 0
        ? '🔴 Complet'
        : remaining === qty
          ? `🟢 ${qty} place${qty > 1 ? 's' : ''}`
          : `🟡 ${remaining}/${qty} restante${remaining > 1 ? 's' : ''}`;
    const shortAddr = o.address.length > 40 ? o.address.slice(0, 40) + '…' : o.address;
    lines.push(
      `${num}- *${o.title}*`,
      `    • 💰 Montant : ${o.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
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
      "Tapez un numéro pour sélectionner une offre ou *Menu* pour revenir au menu.",
    );
  }
  return lines.join('\n');
}

export function formatOfferDetail(offer: OfferListItem): string {
  const flow = formatPaymentFlow(offer.payment_flow);
  const lines = [
    `*OFFRE #${offer.id.slice(0, 8)} - DÉTAILS COMPLETS*`,
    '',
    `*Titre*: ${offer.title}`,
    '',
    '*Description complète*:',
    offer.description,
    '',
    `*Date et heure*: ${formatDate(offer.scheduled_at)}`,
    `*Rémunération*: ${offer.amount.toLocaleString('fr-FR')} FCFA ${flow}`,
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
  const flow = formatPaymentFlow(offer.payment_flow);
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
    `*Montant*: ${offer.amount.toLocaleString('fr-FR')} FCFA ${flow}`,
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
