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
