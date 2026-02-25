const SEP = '━━━━━━━━━━━━━━━━━━';

function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPaymentFlow(flow: string): string {
  const map: Record<string, string> = {
    HOURLY: 'par heure',
    DAILY: 'par jour',
    MONTHLY: 'par mois',
  };
  return map[flow] ?? flow;
}

function applicationStatusLabel(status: string): string {
  if (status === 'ACCEPTED') return '✅ ACCEPTÉE';
  if (status === 'PENDING') return '⏳ EN ATTENTE';
  if (status === 'REJECTED') return '❌ REFUSÉE';
  return '⚠️ ANNULÉE';
}

export type ApplicationForList = {
  id: string;
  status: string;
  job_offer: {
    id: string;
    title: string;
    scheduled_at: Date;
    amount: number;
    address: string;
    status: string;
  };
};

export function formatMyApplicationsList(
  applications: ApplicationForList[],
): string {
  if (applications.length === 0) {
    return "Vous n'avez aucune candidature. Tapez 'Menu' puis 1 pour voir les offres.";
  }

  const lines = [`📋 Mes candidatures (${applications.length})`, '', SEP];

  for (const app of applications) {
    const statusEmoji = applicationStatusLabel(app.status);
    lines.push(
      statusEmoji,
      `📌 ${app.job_offer.title}`,
      `🕐 ${formatDate(app.job_offer.scheduled_at)}`,
      `💰 ${app.job_offer.amount.toLocaleString('fr-FR')} FCFA`,
      `📍 ${app.job_offer.address.slice(0, 30)}${app.job_offer.address.length > 30 ? '...' : ''}`,
      '',
      '1️⃣ Voir détails / Annuler',
      SEP,
      '',
    );
  }

  lines.push("Tapez le numéro de l'option ou 'Menu' pour revenir.");
  return lines.join('\n');
}

export function formatApplyConfirmation(params: {
  title: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  workerName: string;
  workerPhone: string;
  workerEmail: string;
  reliabilityScore: number | null;
}): string {
  const flow = formatPaymentFlow(params.payment_flow);
  return [
    '📋 Vous êtes sur le point de postuler',
    '',
    `📌 Offre: ${params.title}`,
    `🕐 Date: ${formatDate(params.scheduled_at)}`,
    `💰 Montant: ${params.amount.toLocaleString('fr-FR')} FCFA ${flow}`,
    `📍 ${params.address}`,
    '',
    '⚠️ Engagement important:',
    "✓ Vos informations seront partagées avec l'employeur",
    '✓ Vous vous engagez à être présent et ponctuel',
    '✓ Annulation < 4h avant = pénalité de 5,000 FCFA',
    '✓ Impact sur votre score de fiabilité',
    '',
    'Votre profil sera envoyé:',
    `• Nom: ${params.workerName}`,
    `• Téléphone: ${params.workerPhone}`,
    `• Email: ${params.workerEmail}`,
    `• Score: ⭐ ${params.reliabilityScore ?? 100}/100`,
    '',
    'Confirmez-vous votre candidature ?',
    '1️⃣ Oui, je postule',
    '2️⃣ Non, retour',
    '',
    'Tapez 1 ou 2.',
  ].join('\n');
}

export function formatApplicationSentSuccess(offerTitle: string): string {
  return [
    '✅ Candidature envoyée !',
    '',
    `Votre candidature pour "${offerTitle}" a été transmise à l'employeur.`,
    '',
    '📊 Statut: En attente de réponse',
    "🔔 Vous serez notifié dès que l'employeur prendra une décision.",
    '',
    '💡 Astuce: Consultez "Menu > Mes candidatures" pour suivre vos postulations.',
    '',
    "Tapez 'Menu' pour revenir.",
  ].join('\n');
}

export function formatNewApplicationToEmployer(params: {
  offerTitle: string;
  workerName: string;
  workerPhone: string;
  workerEmail: string;
  workerDescription: string;
  reliabilityScore: number | null;
  completedMissions: number;
  scheduledAt: Date;
  address: string;
}): string {
  const score = params.reliabilityScore ?? 100;
  return [
    '🎉 Nouvelle candidature !',
    '',
    'Un worker a postulé à votre offre :',
    `📌 ${params.offerTitle}`,
    '',
    '👤 Candidat:',
    SEP,
    `• Nom: ${params.workerName}`,
    `• Téléphone: ${params.workerPhone}`,
    `• Email: ${params.workerEmail}`,
    `• Description: ${params.workerDescription.slice(0, 200)}${params.workerDescription.length > 200 ? '...' : ''}`,
    SEP,
    `⭐ Score de fiabilité: ${score}/100`,
    `✅ Missions complétées: ${params.completedMissions}`,
    '',
    `🕐 Rendez-vous prévu: ${formatDate(params.scheduledAt)}`,
    `📍 ${params.address}`,
    '',
    'Actions:',
    '1️⃣ Accepter le candidat',
    '2️⃣ Voir son profil complet',
    '3️⃣ Refuser',
    '',
    'Tapez le numéro correspondant.',
  ].join('\n');
}

export function formatApplicationAcceptedToWorker(
  employerName: string,
  employerPhone: string,
): string {
  return [
    '✅ Candidature acceptée !',
    '',
    `L'employeur vous a accepté. Vous pouvez le contacter directement :`,
    `👤 ${employerName}`,
    `📞 ${employerPhone}`,
    '',
    'Bonne collaboration ! 🤝',
  ].join('\n');
}

export function formatApplicationRejectedToWorker(): string {
  return [
    '❌ Candidature refusée',
    '',
    "L'employeur a choisi un autre candidat pour cette offre.",
    "Consultez d'autres offres avec Menu > 1.",
  ].join('\n');
}

export function formatCancellationToEmployer(params: {
  workerName: string;
  offerTitle: string;
  scheduledAt: Date;
  reason: string | null;
  wasLatePenalty: boolean;
}): string {
  const lines = [
    '⚠️ Annulation de candidature',
    '',
    `Le worker ${params.workerName} a annulé sa candidature pour :`,
    `📌 ${params.offerTitle}`,
    `🕐 ${formatDate(params.scheduledAt)}`,
    '',
    `💬 Raison: ${params.reason ?? 'Aucune raison donnée'}`,
    '',
  ];
  if (params.wasLatePenalty) {
    lines.push(
      '⚠️ Note: Cette annulation était tardive (< 4h). Une pénalité a été appliquée au worker.',
      '',
    );
  }
  lines.push(
    "Votre offre est de nouveau disponible pour d'autres candidats.",
    '',
    'Actions:',
    '1️⃣ Voir les autres candidatures',
    "2️⃣ Republier l'offre",
    "3️⃣ Supprimer l'offre",
    '',
    'Tapez le numéro correspondant.',
  );
  return lines.join('\n');
}
