/**
 * An application reached ACCEPTED, by any code path. Emitted by the outbox
 * consumer (`AgentEventsConsumer`) from the `applications_accepted_outbox`
 * trigger, so every way of accepting is covered without each one emitting.
 */
export const APPLICATION_ACCEPTED_EVENT = 'application.accepted';

export type ApplicationAcceptedPayload = {
  applicationId: string;
  workerId: string;
  jobOfferId: string;
};
