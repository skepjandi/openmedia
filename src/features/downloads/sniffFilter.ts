import type { DownloadKind, FoundMedia } from "../../shared/ipc";

export type KindFilter = "all" | DownloadKind;

export const KIND_FILTERS: readonly KindFilter[] = [
  "all",
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
];

/** How many addresses of each kind the page offered, for the filter chips. */
export function countByKind(items: FoundMedia[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = {
    all: items.length,
    image: 0,
    video: 0,
    audio: 0,
    document: 0,
    archive: 0,
    other: 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

/** The expression the user typed, or null when it is empty or not a valid one. */
export function compilePattern(text: string): RegExp | null | "invalid" {
  if (!text) return null;
  try {
    return new RegExp(text, "i");
  } catch {
    return "invalid";
  }
}

/** What the filter chips and the expression leave of the page's list. An invalid expression filters nothing. */
export function filterMedia(items: FoundMedia[], kind: KindFilter, pattern: string): FoundMedia[] {
  const expression = compilePattern(pattern);
  return items.filter((item) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (expression === null || expression === "invalid") return true;
    return expression.test(item.url) || expression.test(item.label);
  });
}
