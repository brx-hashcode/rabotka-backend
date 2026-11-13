import { ForbiddenException } from '@nestjs/common';
import type { BusinessSubscriptionService } from '../subscription/business-subscription.service';

export const VIDEO_PLAN_REFUSAL =
  'La visio dans Rabotka est incluse dans les formules supérieures. Collez un lien Meet ou Zoom, ou changez de formule depuis la rubrique « Abonnement ».';

/**
 * « Visio dans Rabotka » is a plan service: a new link made in Rabotka, a
 * guest invited, the transcription switched on. What is already booked keeps
 * working; a Meet or Zoom link pasted by hand is open to every plan.
 */
export async function assertVideoPlan(
  subscriptions: Pick<BusinessSubscriptionService, 'entitlements'>,
  businessId: string,
): Promise<void> {
  const e = await subscriptions.entitlements(businessId);
  if (!e.videoInterviews) throw new ForbiddenException(VIDEO_PLAN_REFUSAL);
}
