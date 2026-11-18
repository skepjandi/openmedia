import type { Download, DownloadStatus } from "../../shared/ipc";

/** Statuses in which a download is still moving or waiting its turn. */
const ACTIVE: readonly DownloadStatus[] = ["queued", "downloading"];

export const isActive = (download: Download): boolean => ACTIVE.includes(download.status);
export const isFinished = (download: Download): boolean =>
  download.status === "done" || download.status === "failed" || download.status === "cancelled";

/** The list with `update` in it: replaced where it is already listed, added at the end otherwise. */
export function upsert(list: Download[], update: Download): Download[] {
  const index = list.findIndex((download) => download.id === update.id);
  if (index < 0) return [...list, update];
  const next = list.slice();
  next[index] = update;
  return next;
}

/** Whether `update` is the moment a download stops being in progress, as opposed to another update of a finished one. */
export function justEnded(list: Download[], update: Download): boolean {
  if (update.status !== "done" && update.status !== "failed") return false;
  const before = list.find((download) => download.id === update.id);
  return before !== undefined && isActive(before);
}

/** Newest first. */
export const newestFirst = (list: Download[]): Download[] =>
  list.slice().sort((a, b) => b.addedAt - a.addedAt);

/** How far along, 0 to 1; null while the size is unknown. */
export function fraction(download: Download): number | null {
  if (download.status === "done") return 1;
  if (!download.total) return null;
  return Math.min(1, download.received / download.total);
}
