import { APP_TIMEZONE } from '../utils/parse-date-time';
import type { FreeFormMessage } from '../../notification-dispatch/notification-dispatcher.service';

/**
 * The free-form rendering of each notification template.
 *
 * These exist because inside the 24h customer-service window the same words can
 * be sent as plain text with a button, at no template fee — see
 * `NotificationDispatcher`. The approved copy lives at Meta and cannot be read
 * from here, so each function below is written to CARRY THE SAME FACTS as its
 * template: the reader must not be able to tell which path was taken, and a
 * fact dropped here is a fact that silently stops reaching half the users.
 *
 * Keep them one screen long, in French, ending on the action the button
 * performs. The button label is part of the message, not decoration: it is the
 * only thing that opens WhatsApp's in-app browser.
 */

/**
 * An offer's closing date, or a placeholder when it has none.
 *
 * CDI/CDD/STAGE offers carry no closing date, and every WhatsApp message that
 * prints one needs something to say. Returning a placeholder here rather than
 * at each call site is what stops one of them rendering "Invalid Date" or,
 * worse, the epoch.
 */
export function formatDate(d: Date | null | undefined): string {
  if (!d) return 'Non précisée';
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIMEZONE,
  });
}

/** `newApplication` — a worker applied to the employer's offer. */
export function newApplicationFreeForm(p: {
  offerTitle: string;
  workerName: string;
  reliabilityScore: number;
  completedMissions: number;
  workerDescription: string;
  scheduledAt: string;
  address: string;
  applicationId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Nouvelle candidature*',
      '',
      `Offre : ${p.offerTitle}`,
      `Candidat : ${p.workerName}`,
      `Fiabilité : ${p.reliabilityScore}/100 · ${p.completedMissions} mission(s) terminée(s)`,
      `Présentation : ${p.workerDescription}`,
      '',
      `Date : ${p.scheduledAt}`,
      `Lieu : ${p.address}`,
      '',
      'Ouvrez la candidature pour accepter ou refuser.',
    ].join('\n'),
    buttonText: 'Voir la candidature',
    path: `candidatures/${p.applicationId}`,
  };
}

/** `kyc` — the identity documents were approved. */
export function kycApprovedFreeForm(name: string): FreeFormMessage {
  return {
    body: [
      '*Votre compte est vérifié*',
      '',
      `Bonjour ${name}, vos documents ont été validés par notre équipe.`,
      '',
      'Vous avez maintenant accès à toutes les fonctionnalités de Rabotka.',
    ].join('\n'),
    buttonText: 'Ouvrir Rabotka',
    path: 'home',
  };
}

/**
 * `kycRejected` — the documents were refused, with the admin's reason.
 *
 * Worth the free path: someone refused usually writes back within the hour to
 * ask why, so the next message in that thread is free too.
 */
export function kycRejectedFreeForm(p: {
  firstName: string;
  reason: string;
}): FreeFormMessage {
  return {
    body: [
      '*Vérification refusée*',
      '',
      `Bonjour ${p.firstName}, vos documents n’ont pas pu être validés.`,
      `Motif : ${p.reason}`,
      '',
      'Vous pouvez nous envoyer de nouveaux documents ou ouvrir une réclamation.',
    ].join('\n'),
    buttonText: 'Ouvrir une réclamation',
    path: 'claims/new',
  };
}

/** `accountSuspended` — the account was suspended, with the admin's reason. */
export function accountSuspendedFreeForm(p: {
  firstName: string;
  reason: string;
}): FreeFormMessage {
  return {
    body: [
      '*Compte suspendu*',
      '',
      `Bonjour ${p.firstName}, votre compte a été suspendu.`,
      `Motif : ${p.reason}`,
      '',
      'Répondez à ce message si vous pensez qu’il s’agit d’une erreur.',
    ].join('\n'),
    buttonText: 'Ouvrir Rabotka',
    path: 'home',
  };
}

/** `accountActivatedWorker` / `accountActivatedEmployer`. */
export function accountActivatedFreeForm(p: {
  firstName: string;
  path: string;
  isWorker: boolean;
}): FreeFormMessage {
  return {
    body: [
      '*Votre compte est actif*',
      '',
      `Bonjour ${p.firstName}, votre compte Rabotka est maintenant actif.`,
      '',
      p.isWorker
        ? 'Complétez votre profil et vos réalisations pour recevoir des missions qui vous correspondent.'
        : 'Publiez votre première offre pour recevoir des candidatures.',
    ].join('\n'),
    buttonText: 'Ouvrir Rabotka',
    path: p.path,
  };
}

/**
 * `claimCommented` — an admin answered a support claim.
 *
 * The highest-value free-form case in the product: someone in a support
 * conversation has almost always written to us in the last 24h, so this is a
 * template fee paid to reach a chat that is already open.
 */
export function claimCommentedFreeForm(p: {
  firstName: string;
  claimTitle: string;
  excerpt: string;
  claimId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Réponse à votre réclamation*',
      '',
      `Bonjour ${p.firstName}, notre équipe a répondu à « ${p.claimTitle} » :`,
      '',
      p.excerpt,
      '',
      'Vous pouvez répondre directement dans l’application.',
    ].join('\n'),
    buttonText: 'Voir la réclamation',
    path: `claims/${p.claimId}`,
  };
}

/** `profileViewsDigest` — unread profile views have piled up. */
export function profileViewsDigestFreeForm(p: {
  firstName: string;
  count: number;
}): FreeFormMessage {
  return {
    body: [
      '*Votre profil intéresse*',
      '',
      `Bonjour ${p.firstName}, ${p.count} employeur(s) ont consulté votre profil récemment.`,
      '',
      'Un profil complet et des réalisations à jour donnent plus de chances d’être contacté.',
    ].join('\n'),
    buttonText: 'Voir mes notifications',
    path: 'notifications',
  };
}

/** `unlockExpiredConversion` — an unpaid unlock turned into wallet credit. */
export function unlockExpiredConversionFreeForm(p: {
  amount: number;
}): FreeFormMessage {
  return {
    body: [
      '*Votre paiement a été converti en crédit*',
      '',
      `La mission n’a pas abouti dans les délais. ${p.amount.toLocaleString('fr-FR')} FCFA ont été crédités sur votre portefeuille.`,
      '',
      'Ce crédit est utilisable sur vos prochaines missions.',
    ].join('\n'),
    buttonText: 'Voir mon portefeuille',
    path: 'portefeuille',
  };
}

/** `reminder24h` — the mission starts tomorrow. */
export function reminder24hFreeForm(p: {
  offerTitle: string;
  date: string;
  address: string;
  amount: string;
  employerName: string;
  employerPhone: string;
  cancellationThresholdHours: string;
  penaltyFcfa: string;
  applicationId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre mission commence demain*',
      '',
      `${p.offerTitle}`,
      `Date : ${p.date}`,
      `Lieu : ${p.address}`,
      `Rémunération : ${p.amount} FCFA`,
      `Employeur : ${p.employerName} — ${p.employerPhone}`,
      '',
      // The penalty terms are the reason this message is worth sending at all:
      // a worker who drops out late costs the employer the mission, and this
      // is the last moment they can cancel without being charged for it.
      `En cas d’annulation à moins de ${p.cancellationThresholdHours}h du début, une pénalité de ${p.penaltyFcfa} FCFA s’applique.`,
    ].join('\n'),
    buttonText: 'Voir ma mission',
    path: `applications/${p.applicationId}`,
  };
}

/** `reminderStart` — the mission starts now. */
export function reminderStartFreeForm(p: {
  offerTitle: string;
  time: string;
  address: string;
  employerName: string;
  employerPhone: string;
  applicationId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre mission commence*',
      '',
      `${p.offerTitle}`,
      `Heure : ${p.time}`,
      `Lieu : ${p.address}`,
      `Employeur : ${p.employerName} — ${p.employerPhone}`,
      '',
      'Prévenez l’employeur si vous avez du retard.',
    ].join('\n'),
    buttonText: 'Voir ma mission',
    path: `applications/${p.applicationId}`,
  };
}

/** `autoStarted` — the mission's hour arrived, so it started itself. */
export function autoStartedFreeForm(p: {
  offerTitle: string;
  jobOfferId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Mission démarrée*',
      '',
      `« ${p.offerTitle} » a démarré à l’heure prévue.`,
      '',
      'Vous pourrez la clôturer et noter le travailleur une fois terminée.',
    ].join('\n'),
    buttonText: 'Voir la mission',
    path: `missions/${p.jobOfferId}`,
  };
}

/** `statusCheck` — is the mission finished? Asked of the hired worker. */
export function statusCheckFreeForm(p: {
  jobTitle: string;
  jobOfferId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre mission est-elle terminée ?*',
      '',
      `« ${p.jobTitle} »`,
      '',
      'Confirmez la fin de la mission pour débloquer la notation.',
    ].join('\n'),
    buttonText: 'Confirmer',
    path: `missions/${p.jobOfferId}`,
  };
}

/** `offerExpiredApplicant` — the offer closed without hiring this worker. */
export function offerExpiredApplicantFreeForm(p: {
  offerTitle: string;
}): FreeFormMessage {
  return {
    body: [
      '*Offre expirée*',
      '',
      `« ${p.offerTitle} » est arrivée à échéance et votre candidature est close.`,
      '',
      'D’autres missions sont disponibles.',
    ].join('\n'),
    buttonText: 'Voir les offres',
    path: 'recherche-offres',
  };
}

/** `offerExpiredEmployer` — nobody was hired before the deadline. */
export function offerExpiredEmployerFreeForm(p: {
  offerTitle: string;
  jobOfferId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre offre a expiré*',
      '',
      `« ${p.offerTitle} » est arrivée à échéance sans recrutement.`,
      '',
      'Vous pouvez la republier avec une nouvelle date.',
    ].join('\n'),
    buttonText: 'Republier mon offre',
    path: `job-offers/${p.jobOfferId}`,
  };
}

/** `applicationAccepted` — the employer chose this worker, nothing to pay. */
export function applicationAcceptedFreeForm(p: {
  employerName: string;
  offerTitle: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre candidature est acceptée*',
      '',
      `${p.employerName} vous a retenu(e) pour « ${p.offerTitle} ».`,
      '',
      'Consultez les détails de la mission dans l’application.',
    ].join('\n'),
    buttonText: 'Voir ma candidature',
    path: 'mes-candidatures',
  };
}

/**
 * `applicationAcceptedUnlock` — accepted, but the worker's share of the contact
 * unlock is still due. The amount is deliberately not stated: it is settled on
 * the page the button opens, where it is authoritative.
 */
export function applicationAcceptedUnlockFreeForm(p: {
  employerName: string;
  offerTitle: string;
  applicationId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Votre candidature est acceptée*',
      '',
      `${p.employerName} vous a retenu(e) pour « ${p.offerTitle} ».`,
      '',
      'Il reste votre part à régler pour débloquer les coordonnées et confirmer la mission.',
    ].join('\n'),
    buttonText: 'Régler ma part',
    path: `applications/${p.applicationId}`,
  };
}

/**
 * `applicationRejected` — not retained.
 *
 * The template carries no employer name and no offer title, and neither does
 * this: the message exists to release the worker, not to dwell on it.
 */
export function applicationRejectedFreeForm(): FreeFormMessage {
  return {
    body: [
      '*Candidature non retenue*',
      '',
      'Votre candidature n’a pas été retenue cette fois.',
      '',
      'D’autres missions correspondant à votre profil sont disponibles.',
    ].join('\n'),
    buttonText: 'Voir les offres',
    path: 'recherche-offres',
  };
}

/** `cancellation` — the other party cancelled. */
export function cancellationFreeForm(p: {
  workerName: string;
  offerTitle: string;
  date: string;
  reason: string;
  penaltyStatus: string;
  jobOfferId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Annulation*',
      '',
      `${p.workerName} a annulé « ${p.offerTitle} » prévue le ${p.date}.`,
      `Raison : ${p.reason}`,
      `Pénalité : ${p.penaltyStatus}`,
      '',
      'Vous pouvez choisir un autre candidat depuis votre offre.',
    ].join('\n'),
    buttonText: 'Voir mon offre',
    path: `job-offers/${p.jobOfferId}`,
  };
}

/**
 * `jobRecommendation` — a new offer matches this worker's profile.
 *
 * The one MARKETING template among the notifications, so the free-form path
 * saves the most here — and it is also the one a marketing opt-out can drop
 * entirely, which free-form is not subject to.
 */
export function jobRecommendationFreeForm(p: {
  firstName: string;
  title: string;
  amount: string;
  address: string;
  date: string;
  jobOfferId: string;
}): FreeFormMessage {
  return {
    body: [
      '*Une mission pour vous*',
      '',
      `Bonjour ${p.firstName}, une mission correspond à votre profil :`,
      '',
      `${p.title}`,
      `Rémunération : ${p.amount}`,
      `Lieu : ${p.address}`,
      `Date : ${p.date}`,
      '',
      'Postulez avant qu’elle ne soit pourvue.',
    ].join('\n'),
    buttonText: 'Voir la mission',
    path: `offres/${p.jobOfferId}`,
  };
}

/** `contactUnlocked` — both parties paid; the counterpart's details. */
export function contactUnlockedFreeForm(p: {
  name: string;
  phone: string | null;
  email: string | null;
}): FreeFormMessage {
  return {
    body: [
      '*Contact débloqué*',
      '',
      `Les deux parties ont réglé leur part. Voici les coordonnées de *${p.name}* :`,
      '',
      `Téléphone : ${p.phone?.trim() || 'Non renseigné'}`,
      `Email : ${p.email?.trim() || 'Non renseigné'}`,
      '',
      'Un premier message pour vous présenter et confirmer votre présence, et tout est prêt.',
      '',
      'Toute l’équipe Rabotka vous souhaite une excellente collaboration.',
    ].join('\n'),
    buttonText: 'Ouvrir l’application',
    path: 'home',
  };
}

/** `contactUnlockedRecommendation` — the employer paid to reach a recommended worker. */
export function contactUnlockedRecommendationFreeForm(p: {
  name: string;
  phone: string | null;
  email: string | null;
}): FreeFormMessage {
  return {
    body: [
      '*Contact débloqué*',
      '',
      `Votre paiement est confirmé. Voici comment joindre *${p.name}* :`,
      '',
      `Téléphone : ${p.phone?.trim() || 'Non renseigné'}`,
      `Email : ${p.email?.trim() || 'Non renseigné'}`,
      '',
      'Présentez-lui votre mission dès maintenant — les profils les plus demandés répondent vite.',
      '',
      'Toute l’équipe Rabotka vous souhaite une excellente collaboration.',
    ].join('\n'),
    buttonText: 'Ouvrir l’application',
    path: 'home',
  };
}
