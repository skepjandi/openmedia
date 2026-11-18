import { downloads } from "../../shared/ipc";

const MAX_AT_ONCE = 4;
const cache = new Map<string, Promise<string | null>>();
const waiting: (() => void)[] = [];
let running = 0;

function next(): void {
  while (running < MAX_AT_ONCE && waiting.length > 0) {
    running += 1;
    waiting.shift()?.();
  }
}

/** The picture for an image address, fetched a few at a time and remembered. Null when there is none. */
export function thumbnail(url: string, pageUrl: string): Promise<string | null> {
  const key = `${pageUrl}\n${url}`;
  const known = cache.get(key);
  if (known) return known;
  const made = new Promise<string | null>((resolve) => {
    waiting.push(() => {
      downloads
        .thumbnail(url, pageUrl || undefined)
        .catch(() => null)
        .then(resolve)
        .finally(() => {
          running -= 1;
          next();
        });
    });
    next();
  });
  cache.set(key, made);
  return made;
}
