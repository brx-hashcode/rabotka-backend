import type { Coordinates } from './geocoding.service';

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Proximity score 0–1. Distance 0 km → 1.0, falls off with a half-life of
 * `halfLifeKm` (default 5 km — tuned for a city like Brazzaville).
 */
export function proximityScore(distanceKm: number, halfLifeKm = 5): number {
  return Math.exp((-Math.LN2 * distanceKm) / halfLifeKm);
}

/** A declared location, as stored on a profile. */
export type PlaceRef = {
  countryCode: string | null | undefined;
  city: string | null | undefined;
};

/**
 * What `proximityScore` returns for a coarse country/city match, and what it
 * returned before there was one.
 *
 * `UNKNOWN` is the historical value: whenever either side had no coordinates,
 * proximity collapsed to a flat 0.5. That is a third of the cold-start weight
 * spent on a constant — it moved every candidate equally and therefore ranked
 * nothing, while geocoding failures (which are fire-and-forget, so silent and
 * permanent) quietly put people in that bucket for good.
 *
 * The three graded values are the fix. They are deliberately NOT on the
 * haversine curve: `SAME_CITY` is below what an exact-coordinate match scores,
 * because "same city" is genuinely weaker evidence than "800 m away" and must
 * not be able to outrank it.
 */
export const GEO_MATCH_SCORE = {
  /** Same country and same city. */
  SAME_CITY: 0.85,
  /** Same country, different city — plausibly reachable, clearly not local. */
  SAME_COUNTRY: 0.45,
  /** Different countries. Not zero: cross-border work exists near Kinshasa. */
  DIFFERENT_COUNTRY: 0.1,
  /** Neither side declared anything. The pre-existing neutral value. */
  UNKNOWN: 0.5,
} as const;

/**
 * Coarse proximity from declared country/city, for when coordinates are absent
 * on either side.
 *
 * Only ever a FALLBACK — callers must prefer `proximityScore` over a real
 * haversine distance whenever both sides are geocoded. This exists because a
 * profile with no coordinates was previously indistinguishable from one across
 * the world.
 */
export function placeProximityScore(a: PlaceRef, b: PlaceRef): number {
  const countryA = a.countryCode?.trim().toUpperCase();
  const countryB = b.countryCode?.trim().toUpperCase();
  if (!countryA || !countryB) return GEO_MATCH_SCORE.UNKNOWN;
  if (countryA !== countryB) return GEO_MATCH_SCORE.DIFFERENT_COUNTRY;

  const cityA = a.city?.trim().toLowerCase();
  const cityB = b.city?.trim().toLowerCase();
  // Same country with a city missing on either side: we know they share a
  // country and nothing more, which is exactly SAME_COUNTRY.
  if (!cityA || !cityB) return GEO_MATCH_SCORE.SAME_COUNTRY;

  return cityA === cityB
    ? GEO_MATCH_SCORE.SAME_CITY
    : GEO_MATCH_SCORE.SAME_COUNTRY;
}

/**
 * Urgency score 0–1. A job scheduled now → 1.0, falls off with a half-life
 * of `halfLifeHours` (default 48 h).
 */
export function urgencyScore(scheduledAt: Date, halfLifeHours = 48): number {
  const hoursUntil = Math.max(
    0,
    (scheduledAt.getTime() - Date.now()) / (1000 * 60 * 60),
  );
  return Math.exp((-Math.LN2 * hoursUntil) / halfLifeHours);
}
