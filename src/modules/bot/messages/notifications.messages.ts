import { APP_TIMEZONE } from '../utils/parse-date-time';

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
