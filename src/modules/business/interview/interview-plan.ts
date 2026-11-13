import { ForbiddenException } from '@nestjs/common';
import type { BusinessSubscriptionService } from '../subscription/business-subscription.service';

export const VIDEO_PLAN_REFUSAL =
  'La visio dans Rabotka est incluse dans les formules supérieures. Collez un lien Meet ou Zoom, ou changez de formule depuis la rubrique « Abonnement ».';

/**
 * « Visio dans Rabotka » is a plan service: a new link made in Rabotka, a
 * guest invited, the transcription switched on, and joining a room: one
 * already booked closes too when the plan lacks the service; a Meet
 * or Zoom link pasted by hand is open to every plan.
 */
export async function assertVideoPlan(
  subscriptions: Pick<BusinessSubscriptionService, 'entitlements'>,
  businessId: string,
  refusal: string = VIDEO_PLAN_REFUSAL,
): Promise<void> {
  const e = await subscriptions.entitlements(businessId);
  if (!e.videoInterviews) throw new ForbiddenException(refusal);
}

/** To the candidate or a guest: the visio is closed, without the plan's words. */
export const VIDEO_GUEST_REFUSAL =
  'Cette visio n’est pas disponible. L’entreprise vous indiquera comment se tiendra l’entretien.';

/** The AI report comes with the visio service (« de la visio au compte rendu »); notes stay free. */
export const REPORT_PLAN_REFUSAL =
  'Le compte rendu rédigé par IA est inclus dans les formules supérieures. Vos notes restent enregistrées : changez de formule depuis la rubrique « Abonnement ».';
