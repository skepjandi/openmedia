const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** A byte count for people: `1.4 MB`, `812 KB`. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export const formatSpeed = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`;

/** Time left as `1h 05m`, `3m 20s` or `45s`; null when it cannot be told. */
export function formatEta(remainingBytes: number, bytesPerSecond: number): string | null {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return null;
  const seconds = Math.ceil(remainingBytes / bytesPerSecond);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}
