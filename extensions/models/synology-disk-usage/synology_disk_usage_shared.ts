/**
 * Shared formatting helpers for the Synology disk usage model and report.
 *
 * Kept dependency-free so the report can import it without pulling the whole
 * model (and its ssh subprocess seam) into the report bundle.
 *
 * @module
 */

/** Format bytes as a human-readable binary size (e.g. `1.4 GiB`). */
export function humanSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value.toString() : value.toFixed(1)} ${units[i]}`;
}
