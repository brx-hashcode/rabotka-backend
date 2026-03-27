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
): string {
  const lines = ['*CANDIDATURES REÇUES*', ''];
  items.forEach((app, i) => {
    const num = i + 1;
    const offerLine = app.offerTitle ? `    Offre: ${app.offerTitle}` : '';
    lines.push(
      `${num}. ${app.firstName} ${app.lastName}`,
      `    Score: ${app.score}/100`,
      ...(offerLine ? [offerLine] : []),
    );
  });
  lines.push('');
  if (hasMore) {
    lines.push(
      '6️⃣ Voir plus',
      '7️⃣ Menu',
      '',
      "Veuillez taper un numéro (1-5), 6️⃣ pour la suite, ou 7️⃣ / 'Menu' pour revenir au menu",
    );
  } else {
    lines.push("Veuillez taper un numéro ou 'Menu' pour revenir au menu");
  }
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
    `Email: ${params.email}`,
    ...(params.offerTitle ? [`Offre: ${params.offerTitle}`] : []),
    `Statut: ${statusLabel}`,
    `Score: ${params.score}/100`,
    '',
    '*Actions:*',
    '1️⃣ Accepter',
    '2️⃣ Refuser',
    '3️⃣ Retour',
    "4️⃣ Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ];
  const body = bodyLines.join('\n');

  if (params.avatarUrl) {
    // Start with [IMG:...] so WhatsAppController sends it as media + caption
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

function formatPaymentFlow(flow: string): string {
  const map: Record<string, string> = {
    HOURLY: 'par heure',
    DAILY: 'par jour',
    MONTHLY: 'par mois',
  };
  return map[flow] ?? flow;
}

function applicationStatusLabel(status: string): string {
  if (status === 'ACCEPTED') return '*ACCEPTÉE*';
  if (status === 'PENDING') return '*EN ATTENTE*';
  if (status === 'VIEWED') return "*VUE PAR L'EMPLOYEUR*";
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
    payment_flow: string;
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
    const flowLabel = formatPaymentFlow(app.job_offer.payment_flow);
    const statusText = applicationStatusLabel(app.status).replaceAll('*', '');
    const address =
      app.job_offer.address.length > ADDRESS_MAX
        ? app.job_offer.address.slice(0, ADDRESS_MAX) + '...'
        : app.job_offer.address;
    lines.push(
      `${num}. ${app.job_offer.title}`,
      `    Montant: ${app.job_offer.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
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
  payment_flow: string;
  address: string;
  status: string;
};

export function formatMyApplicationDetailWithCancel(
  params: MyApplicationDetailParams,
): string {
  const flowLabel = formatPaymentFlow(params.payment_flow);
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${params.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions:*',
    '1️⃣ Annuler cette candidature',
    '2️⃣ Retour à la liste',
    "3️⃣ Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function formatMyApplicationDetailReadOnly(
  params: MyApplicationDetailParams,
): string {
  const flowLabel = formatPaymentFlow(params.payment_flow);
  const statusText = applicationStatusLabel(params.status).replaceAll('*', '');
  return [
    '*CANDIDATURE SÉLECTIONNÉE*',
    '',
    `*Offre*: ${params.jobTitle}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${params.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
    `*Statut*: ${statusText}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions:*',
    '1️⃣ Retour à la liste',
    "2️⃣ Menu (ou tapez 'Menu')",
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
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
  lateCancellationPenalty?: number;
}): string {
  const flow = formatPaymentFlow(params.payment_flow);
  const penalty = params.lateCancellationPenalty ?? 5000;
  return [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${params.title}`,
    `*Date*: ${formatDate(params.scheduled_at)}`,
    `*Montant*: ${params.amount.toLocaleString('fr-FR')} FCFA ${flow}`,
    `*Adresse*: ${params.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "Vos informations seront partagées avec l'employeur",
    'Vous vous engagez à être présent et ponctuel',
    `Annulation < 4h avant = pénalité de *${penalty.toLocaleString('fr-FR')} FCFA*`,
    'Impact sur votre score de fiabilité',
    '',
    '*Votre profil sera envoyé*:',
    `*Nom*: ${params.workerName}`,
    `*Téléphone*: ${params.workerPhone}`,
    `*Email*: ${params.workerEmail}`,
    `*Score*: ${params.reliabilityScore ?? 100}/100`,
    '',
    '*Confirmez-vous votre candidature ?*',
    '1️⃣ Oui, je postule',
    '2️⃣ Non, retour',
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
    `*Description*: ${params.workerDescription.slice(0, 200)}${params.workerDescription.length > 200 ? '...' : ''}`,
    SEP,
    `*Score de fiabilité*: ${score}/100`,
    `*Missions complétées*: ${params.completedMissions}`,
    '',
    `*Rendez-vous prévu*: ${formatDate(params.scheduledAt)}`,
    `*Adresse*: ${params.address}`,
    '',
    '*Actions*:',
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
}): string {
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
      '*Note*: Cette annulation était tardive (< 4h). Une pénalité a été appliquée au worker.',
      '',
    );
  }
  lines.push(
    "*Votre offre est de nouveau disponible pour d'autres candidats.*",
    '',
    '*Actions*:',
    '1️⃣ Voir les autres candidatures',
    "2️⃣ Republier l'offre",
    "3️⃣ Supprimer l'offre",
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
  amount: number;
  payment_flow: string;
};

export function formatFilledJobsListPage(
  items: FilledJobListItem[],
  hasMore: boolean,
): string {
  const lines = ['*MISSIONS POURVUES*', ''];
  if (items.length === 0) {
    lines.push(
      "Aucune mission pourvue pour le moment. Tapez 'Menu' pour revenir.",
    );
    return lines.join('\n');
  }
  items.forEach((item, i) => {
    const num = i + 1;
    const flowLabel = formatPaymentFlow(item.payment_flow);
    lines.push(
      `${num}. ${item.title}`,
      `    Worker: ${item.workerName}`,
      `    Date: ${formatDatePublic(item.scheduled_at)}`,
      `    Montant: ${item.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
      '',
    );
  });
  if (hasMore) {
    lines.push('6️⃣ Voir plus', '7️⃣ Menu', '');
  }
  lines.push(
    "Tapez un numéro pour sélectionner une mission, ou 'Menu' pour revenir.",
  );
  return lines.join('\n');
}

export function formatFilledJobDetail(params: FilledJobListItem): string {
  const flowLabel = formatPaymentFlow(params.payment_flow);
  return [
    '*Mission sélectionnée*',
    '',
    `*Offre*: ${params.title}`,
    `*Worker*: ${params.workerName}`,
    `*Date*: ${formatDatePublic(params.scheduled_at)}`,
    `*Montant*: ${params.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
    '',
    '*Actions:*',
    '1️⃣ Marquer comme terminée (verser le gain au worker)',
    "2️⃣ Annuler (réouvrir l'offre)",
    '3️⃣ Retour',
    '4️⃣ Menu',
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
