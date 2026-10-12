/**
 * Every in-app path a bell notification can hold that leads to an offer or
 * to one of its applications — see the links in `notification-catalog.ts`.
 * When the offer is deleted these all lead to a page that 404s, so the
 * notifications holding them are kept (they are history) but unlinked.
 *
 * Keep in step with the catalog: a new link shape there that names an offer
 * or an application belongs here too.
 */
export function offerNotificationLinks(
  offerIds: readonly string[],
  applicationIds: readonly string[],
): string[] {
  return [
    ...offerIds.flatMap((id) => [
      `/offres/${id}`,
      `/missions/${id}`,
      `/job-offers/${id}`,
    ]),
    ...applicationIds.flatMap((id) => [
      `/candidatures/${id}`,
      `/applications/${id}`,
      `/applications/${id}/paiement`,
    ]),
  ];
}
