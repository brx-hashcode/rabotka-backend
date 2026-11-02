import { emailButton, escapeHtml } from './layout';

/** Emails to a business about the end of its own offer. */
export function jobOfferExpiringEmail(
  firstName: string,
  jobTitle: string,
  endsAt: string,
  url: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      Votre offre <strong>${escapeHtml(jobTitle)}</strong> se termine le
      <strong>${escapeHtml(endsAt)}</strong> et aucun candidat n'est encore
      retenu.
    </p>
    <p>Consultez vos candidatures avant cette date.</p>
    ${emailButton(url, "Voir l'offre")}
  `;
}

export function jobOfferExpiredEmail(
  firstName: string,
  jobTitle: string,
  url: string,
): string {
  return `
    <p>Bonjour ${escapeHtml(firstName)},</p>
    <p>
      Votre offre <strong>${escapeHtml(jobTitle)}</strong> est arrivée à
      échéance sans recrutement. Elle n'est plus en ligne.
    </p>
    <p>Vous pouvez la republier avec une nouvelle date.</p>
    ${emailButton(url, "Voir l'offre")}
  `;
}
