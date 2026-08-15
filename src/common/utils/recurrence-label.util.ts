export type RecurrenceLabelInput = {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** ISO 8601. Null when the series ends by count, or never. */
  until?: string | null;
  count?: number | null;
};

const FREQUENCY_LABELS: Record<RecurrenceLabelInput['frequency'], string> = {
  DAILY: 'Tous les jours',
  WEEKLY: 'Toutes les semaines',
  MONTHLY: 'Tous les mois',
  YEARLY: 'Tous les ans',
};

/**
 * The repeat rule in one French sentence, for the invitation email and the
 * WhatsApp message.
 *
 * Recipients are told about a series once, when it is created — so if this
 * sentence is missing or wrong, nothing else will tell them the event repeats.
 */
export function recurrenceLabel(
  recurrence: RecurrenceLabelInput | null | undefined,
): string | null {
  if (!recurrence) return null;

  const base = FREQUENCY_LABELS[recurrence.frequency];

  if (recurrence.until) {
    const date = new Date(recurrence.until).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return `${base}, jusqu'au ${date}`;
  }

  if (recurrence.count) {
    return `${base}, ${recurrence.count} fois`;
  }

  return base;
}
