const SEP = '━━━━━━━━━━━━━━━━━━━━';

export type OfferListItem = {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  note: string | null;
  status: string;
};

function formatPaymentFlow(flow: string): string {
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
  const lines = [`📋 Offres disponibles (${total} offres)`, '', SEP];

  for (const o of offers) {
    const summary =
      o.description.length > 60
        ? o.description.slice(0, 60) + '...'
        : o.description;
    lines.push(
      `📌 Offre #${o.id.slice(0, 8)}`,
      o.title,
      '',
      `📝 Résumé: ${summary}`,
      `🕐 ${formatDate(o.scheduled_at)}`,
      `💰 ${o.amount.toLocaleString('fr-FR')} FCFA ${formatPaymentFlow(o.payment_flow)}`,
      `📍 ${o.address.length > 40 ? o.address.slice(0, 40) + '...' : o.address}`,
      '',
      '1️⃣ Postuler',
      '2️⃣ Voir détails',
      SEP,
      '',
    );
  }

  if (pageInfo?.hasNext) {
    lines.push('3️⃣ Offre suivante');
  }
  lines.push('4️⃣ Retour au menu', '', 'Tapez le numéro correspondant.');

  return lines.join('\n');
}

export function formatOfferDetail(offer: OfferListItem): string {
  const flow = formatPaymentFlow(offer.payment_flow);
  const lines = [
    `📋 Offre #${offer.id.slice(0, 8)} - Détails complets`,
    '',
    `📌 Titre: ${offer.title}`,
    '',
    '📝 Description complète:',
    offer.description,
    '',
    `🕐 Date et heure: ${formatDate(offer.scheduled_at)}`,
    `💰 Rémunération: ${offer.amount.toLocaleString('fr-FR')} FCFA ${flow}`,
    `📍 Adresse: ${offer.address}`,
    '',
  ];
  if (offer.note) {
    lines.push(`📌 Note de l'employeur:`, offer.note, '');
  }
  lines.push(
    "👤 Employeur: [Masqué jusqu'à acceptation]",
    '',
    'Actions:',
    '1️⃣ Postuler à cette offre',
    '2️⃣ Retour à la liste',
    '',
    'Tapez le numéro correspondant.',
  );
  return lines.join('\n');
}

export function formatOfferPublishedSuccess(offerId: string): string {
  return [
    '✅ Votre offre a été publiée avec succès !',
    'Elle est maintenant visible par tous les workers.',
    '',
    `Offre ID: #${offerId.slice(0, 8)}`,
    "Vous recevrez une notification dès qu'un worker postulera.",
    '',
    "Tapez 'Menu' pour revenir au menu principal.",
  ].join('\n');
}

export function formatNoOffersAvailable(): string {
  return "Aucune offre disponible pour le moment. Tapez 'Menu' pour revenir.";
}
