/**
 * The parts of an offer a candidate committed to when they applied. A change
 * to any of them is worth telling them about; a reworded title or description
 * is not.
 */
export type JobOfferTerms = {
  amount: number | null;
  scheduled_at: Date | null;
  is_remote: boolean;
  address: string | null;
  city: string | null;
  country_code: string | null;
};

/**
 * What changed between two versions of an offer's terms, as short French
 * labels for the candidate notice. Empty when nothing material changed.
 */
export function describeJobOfferChanges(
  before: JobOfferTerms,
  after: JobOfferTerms,
): string[] {
  const changes: string[] = [];
  if ((before.amount ?? null) !== (after.amount ?? null)) {
    changes.push('la rémunération');
  }
  if (
    (before.scheduled_at?.getTime() ?? null) !==
    (after.scheduled_at?.getTime() ?? null)
  ) {
    changes.push('la date');
  }
  if (
    before.is_remote !== after.is_remote ||
    (before.address ?? null) !== (after.address ?? null) ||
    (before.city ?? null) !== (after.city ?? null) ||
    (before.country_code ?? null) !== (after.country_code ?? null)
  ) {
    changes.push('le lieu');
  }
  return changes;
}

/** « a », « a et b », « a, b et c ». Falls back to a generic phrase. */
export function joinFrench(items: readonly string[]): string {
  if (items.length === 0) return 'les conditions';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}
