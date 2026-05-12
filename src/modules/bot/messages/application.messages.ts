export const SEP = '━━━━━━━━━━━━━━━';

export type CandidatureListItem = {
  id: string;
  fullName: string;
  score: string | number;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  avatarUrl?: string | null;
  offerTitle?: string;
};

export function formatCandidaturesListPage(
  items: CandidatureListItem[],
  hasMore: boolean,
  page = 0,
  totalPages = 1,
): string {
  const pageLabel = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : '';
  const lines = [`*CANDIDATURES REÇUES*${pageLabel}`, ''];
  items.forEach((app, i) => {
    const offerLine = app.offerTitle ? `    Offre: ${app.offerTitle}` : '';
    lines.push(
      `${i + 1}. ${app.firstName} ${app.lastName}`,
      `    Score: ${app.score}/100`,
      ...(offerLine ? [offerLine] : []),
    );
  });
  lines.push('');
  const actions: string[] = [];
  if (page > 0) actions.push('P- Page précédente');
  if (hasMore) actions.push('Voir plus');
  actions.push('M- Menu principal');
  lines.push(...actions, '', 'Tapez un numéro pour voir le détail.');
  return lines.join('\n');
}

function candidatureStatusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === 'VERIFIED') return 'Vérifié';
  if (s === 'PENDING') return 'En cours de vérification';
  if (s === 'REJECTED') return 'Rejeté';
  return status;
}

export function formatCandidatureDetail(params: {
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  score: string | number;
  avatarUrl?: string | null;
  offerTitle?: string;
}): string {
  const statusLabel = candidatureStatusLabel(params.status);
  const bodyLines = [
    '*Candidature sélectionnée:*',
    '',
    `Nom: ${params.lastName}`,
    `Prénom: ${params.firstName}`,
    ...(params.offerTitle ? [`Offre: ${params.offerTitle}`] : []),
    `Statut: ${statusLabel}`,
    `Score: ${params.score}/100`,
    '',
    '*Actions:*',
    '1- Accepter',
    '2- Refuser',
    '3- Retour',
    "4- Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ];
  const body = bodyLines.join('\n');

  if (params.avatarUrl) {
    const caption = body ? `\n${body}` : '';
    return `[IMG:${params.avatarUrl}]${caption}`;
  }

  return body;
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

function formatPaymentFlow(flow: string | null): string {
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
  return `${amount.toLocaleString('fr-FR')} FCFA${flowLabel ? ` ${flowLabel}` : ''}`;
}

function applicationStatusLabel(status: string): string {
  if (status === 'ACCEPTED') return '*ACCEPTÉE*';
  if (status === 'PENDING') return '*EN ATTENTE*';
  if (status === 'VIEWED') return "*VUE PAR L'EMPLOYEUR*";
  if (status === 'WAITING_PAYMENT') return '*EN ATTENTE DE PAIEMENT*';
  if (status === 'REJECTED') return '*REFUSÉE*';
  return '*ANNULÉE*';
}

export type ApplicationForList = {
  id: string;
  status: string;
  job_offer: {
    id: string;
    title: string;
    scheduled_at: Date;
    amount: number;
    payment_flow: string | null;
    address: string;
    status: string;
  };
};

export function formatMyApplicationsList(
  applications: ApplicationForList[],
): string {
  if (applications.length === 0) {
    return "*VOUS N'AVEZ AUCUNE CANDIDATURE. TAPEZ 'MENU' PUIS 1 POUR VOIR LES OFFRES.*";
  }

  const lines = [`*MES CANDIDATURES (${applications.length})*`, ''];

  const ADDRESS_MAX = 40;
  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    const num = i + 1;
    const statusText = applicationStatusLabel(app.status).replaceAll('*', '');
    const address =
      app.job_offer.address.length > ADDRESS_MAX
        ? app.job_offer.address.slice(0, ADDRESS_MAX) + '...'
        : app.job_offer.address;
    lines.push(
      `${num}. ${app.job_offer.title}`,
      `    Montant: ${formatAmount(app.job_offer.amount, app.job_offer.payment_flow)}`,
      `    Date: ${formatDate(app.job_offer.scheduled_at)}`,
      `    Statut: ${statusText}`,
      `    Adresse: ${address}`,
      '',
    );
  }

  lines.push(
    "Veuillez taper un numéro pour sélectionner une candidature ou 'Menu' pour revenir au menu",
  );
  return lines.join('\n');
}

export type MyApplicationDetailParams = {
  jobTitle: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string | null;
  address: string;
  status: string;
};

export function formatMyApplicationDetailWithCancel(
  params: MyApplicationDetailParams,
): string {
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions:*',
    '1- Annuler cette candidature',
    '2- Retour à la liste',
    "3- Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatMyApplicationDetailReadOnly(
  params: MyApplicationDetailParams,
): string {
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions:*',
    '1- Retour à la liste',
    "2- Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatMyApplicationDetailWaitingPayment(
  params: MyApplicationDetailParams,
): string {
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions:*',
    '1- Effectuer le paiement',
    '2- Rejeter et annuler',
    '3- Retour à la liste',
    "4- Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatMyApplicationDetailWaitingPaymentPaid(
  params: MyApplicationDetailParams,
): string {
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '✅ Votre paiement est déjà confirmé.',
    "⏳ En attente du paiement de l'autre partie.",
    '',
    '*Actions:*',
    '1- Rejeter et annuler',
    '2- Retour à la liste',
    "3- Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatApplyConfirmation(params: {
  title: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  workerName: string;
  workerPhone: string;
  workerEmail: string;
  reliabilityScore: number | null;
  lateCancellationPenalty?: number;
  /** Hours before mission start; below this, late cancellation rules apply (system: fees.cancellation_threshold_hours). */
  lateCancellationThresholdHours?: number;
}): string {
  const penalty = params.lateCancellationPenalty ?? 5000;
  const thresholdHours =
    params.lateCancellationThresholdHours != null &&
    params.lateCancellationThresholdHours > 0
      ? params.lateCancellationThresholdHours
      : 4;
  return [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${params.title}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    `*Adresse*: ${params.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "Vos informations seront partagées avec l'employeur",
    'Vous vous engagez à être présent et ponctuel',
    `Annulation < ${thresholdHours}h avant = pénalité de *${penalty.toLocaleString('fr-FR')} FCFA*`,
    'Impact sur votre score de fiabilité',
    '',
    '*Votre profil sera envoyé*:',
    `*Nom*: ${params.workerName}`,
    `*Téléphone*: ${params.workerPhone}`,
    `*Email*: ${params.workerEmail}`,
    `*Score*: ${params.reliabilityScore ?? 100}/100`,
    '',
    '*Confirmez-vous votre candidature ?*',
    '1- Oui, je postule',
    '2- Non, retour',
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatApplicationSentSuccess(offerTitle: string): string {
  return [
    '*Candidature envoyée !*',
    '',
    `Votre candidature pour "${offerTitle}" a été transmise à l'employeur.`,
    '',
    '*Statut*: En attente de réponse',
    "*Vous serez notifié dès que l'employeur prendra une décision.*",
    '',
    '*Astuce*: Consultez "Menu > Mes candidatures" pour suivre vos postulations.',
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
    '*NOUVELLE CANDIDATURE !*',
    '',
    '*Un worker a postulé à votre offre* :',
    `*Offre*: ${params.offerTitle}`,
    '',
    '*CANDIDAT*:',
    SEP,
    `*Nom*: ${params.workerName}`,
    `*Téléphone*: ${params.workerPhone}`,
    `*Email*: ${params.workerEmail}`,
    `*Description*: ${params.workerDescription.slice(0, 150)}${params.workerDescription.length > 150 ? '...' : ''}`,
    SEP,
    `*Score de fiabilité*: ${score}/100`,
    `*Missions complétées*: ${params.completedMissions}`,
    '',
    `*Rendez-vous prévu*: ${formatDate(params.scheduledAt)}`,
    `*Adresse*: ${params.address.length > 80 ? params.address.slice(0, 80) + '...' : params.address}`,
    '',
    '*Actions*:',
    '1- Accepter le candidat',
    '2- Voir son profil complet',
    '3- Refuser',
    '',
    'Tapez le numéro correspondant.',
  ].join('\n');
}

export function formatApplicationAcceptedToWorker(
  employerName: string,
  employerPhone: string,
): string {
  return [
    '*Candidature acceptée !*',
    '',
    `L'employeur vous a accepté. Vous pouvez le contacter directement :`,
    `*Nom*: ${employerName}`,
    `*Téléphone*: ${employerPhone}`,
    '',
    '',
    '*Bonne collaboration ! 🤝*',
  ].join('\n');
}

export function formatApplicationRejectedToWorker(): string {
  return [
    '*Candidature refusée*',
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
  /** Same as fees.cancellation_threshold_hours; used when wasLatePenalty is true. */
  lateCancellationThresholdHours?: number;
}): string {
  const thresholdHours =
    params.lateCancellationThresholdHours != null &&
    params.lateCancellationThresholdHours > 0
      ? params.lateCancellationThresholdHours
      : 4;
  const lines = [
    '*ANNULATION DE CANDIDATURE*',
    '',
    `*Le worker ${params.workerName} a annulé sa candidature pour* :`,
    `*Offre*: ${params.offerTitle}`,
    `*Date*: ${formatDate(params.scheduledAt)}`,
    '',
    `*Raison*: ${params.reason ?? 'Aucune raison donnée'}`,
    '',
  ];
  if (params.wasLatePenalty) {
    lines.push(
      `*Note*: Cette annulation était tardive (< ${thresholdHours}h). Une pénalité a été appliquée au worker.`,
      '',
    );
  }
  lines.push(
    "*Votre offre est de nouveau disponible pour d'autres candidats.*",
    '',
    '*Actions*:',
    '1- Voir les autres candidatures',
    "2- Republier l'offre",
    "3- Supprimer l'offre",
    '',
    'Tapez le numéro correspondant.',
  );
  return lines.join('\n');
}

function formatDatePublic(d: Date | string | null | undefined): string {
  if (d == null) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type FilledJobListItem = {
  applicationId: string;
  title: string;
  workerName: string;
  scheduled_at: Date | string;
  amount: number | null;
  payment_flow: string | null;
};

export function formatFilledJobsListPage(
  items: FilledJobListItem[],
  hasMore: boolean,
  page = 0,
  totalPages = 1,
): string {
  const pageLabel = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : '';
  const lines = [`*MISSIONS POURVUES*${pageLabel}`, ''];
  if (items.length === 0) {
    lines.push(
      "Aucune mission pourvue pour le moment. Tapez 'Menu' pour revenir.",
    );
    return lines.join('\n');
  }
  items.forEach((item, i) => {
    lines.push(
      `${i + 1}. ${item.title}`,
      `    Worker: ${item.workerName}`,
      `    Date: ${formatDatePublic(item.scheduled_at)}`,
      `    Montant: ${formatAmount(item.amount, item.payment_flow)}`,
      '',
    );
  });
  const actions: string[] = [];
  if (page > 0) actions.push('P- Page précédente');
  if (hasMore) actions.push('Voir plus');
  actions.push('M- Menu principal');
  lines.push(...actions, '', 'Tapez un numéro pour sélectionner une mission.');
  return lines.join('\n');
}

export function formatFilledJobDetail(params: FilledJobListItem): string {
  const flowLabel = formatPaymentFlow(params.payment_flow ?? '');
  return [
    '*Mission sélectionnée*',
    '',
    `*Offre*: ${params.title}`,
    `*Worker*: ${params.workerName}`,
    `*Date*: ${formatDatePublic(params.scheduled_at)}`,
    `*Montant*: ${formatAmount(params.amount, params.payment_flow)}`,
    '',
    '*Actions:*',
    '1- Marquer comme terminée (verser le gain au worker)',
    "2- Annuler (réouvrir l'offre)",
    '3- Retour',
    '4- Menu',
    '',
    'Tapez le numéro correspondant.',
  ].join('\n');
}

export function formatJobCompletedToWorker(params: {
  offerTitle: string;
  amount: number;
}): string {
  return [
    '*Mission terminée !*',
    '',
    `L'employeur a marqué la mission "${params.offerTitle}" comme terminée.`,
    `*Gain enregistré*: ${params.amount.toLocaleString('fr-FR')} FCFA`,
    '',
    "Consultez votre profil pour voir vos gains. Tapez 'Menu'.",
  ].join('\n');
}

export function formatJobCancelledByEmployerToWorker(
  offerTitle: string,
): string {
  return [
    "*Mission annulée par l'employeur*",
    '',
    `L'employeur a annulé la mission "${offerTitle}". L'offre est de nouveau ouverte.`,
    '',
    "Tapez 'Menu' pour revenir.",
  ].join('\n');
}
