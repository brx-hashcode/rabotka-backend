/**
 * Day boundaries for user-facing daily limits (e.g. the worker application
 * quota).
 *
 * These deliberately do NOT use `new Date().setHours(0,0,0,0)`, which resolves
 * against the Node process's local timezone — that makes the reset hour depend
 * on whatever TZ the container happens to inherit, so the same code resets at
 * midnight on one host and 01:00 on another.
 *
 * Rabotka operates in the Republic of the Congo (Africa/Brazzaville, WAT), which
 * is UTC+1 with **no daylight saving**, so a fixed offset is exact all year and
 * needs no timezone database.
 */
const BUSINESS_UTC_OFFSET_HOURS = 1;
const HOUR_MS = 60 * 60 * 1000;
const OFFSET_MS = BUSINESS_UTC_OFFSET_HOURS * HOUR_MS;

/** Most recent local midnight, as a UTC instant. */
export function startOfBusinessDay(now: Date = new Date()): Date {
  // Shift into local time, truncate the local day, then shift back to UTC.
  const shifted = new Date(now.getTime() + OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - OFFSET_MS);
}

/** The next local midnight — i.e. when the current day's limits reset. */
export function startOfNextBusinessDay(now: Date = new Date()): Date {
  return new Date(startOfBusinessDay(now).getTime() + 24 * HOUR_MS);
}
