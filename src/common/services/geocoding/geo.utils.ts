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
