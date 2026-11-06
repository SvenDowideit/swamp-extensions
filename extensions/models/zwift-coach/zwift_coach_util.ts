/**
 * Small pure helpers shared by the coach modules.
 *
 * @module
 */

/** Epoch-ms from a `YYYY-MM-DD` date at UTC midnight. */
export function dateMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** `YYYY-MM-DD` from epoch-ms (UTC). */
export function dateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add days to a `YYYY-MM-DD` string. */
export function addDays(date: string, days: number): string {
  return dateString(dateMs(date) + days * 86_400_000);
}

/** Days between two `YYYY-MM-DD` strings. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateMs(b) - dateMs(a)) / 86_400_000);
}

/** Today in UTC, `YYYY-MM-DD`. */
export function todayUtc(): string {
  return dateString(Date.now());
}

/** Clamp `value` into `[lo, hi]`. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Round to one decimal place. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Stable short hash for a plan id (djb2, hex). */
export function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Clamp a session's duration to a sensible workout length. */
export function sessionMinutes(value: number): number {
  return clamp(Math.round(value / 5) * 5, 20, 240);
}
