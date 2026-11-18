import { create } from "zustand";
import { pageTools, type FindResult } from "../../shared/ipc";

export const MAX_FIND_QUERY_CHARS = 200;

interface FindState {
  /** The find bar is on screen. */
  open: boolean;
  query: string;
  /** Where the search stands; null before the first answer and while the query is empty. */
  result: FindResult | null;
  /** The text of the last failure, shown in place of the count. */
  error: string | null;
  openBar: () => void;
  /** Takes the bar and the page's highlights down. */
  closeBar: () => void;
  /** Searches the page for what the person typed; an empty text takes the highlights down. */
  search: (query: string) => Promise<void>;
  /** Moves to the next or previous match. */
  step: (forward: boolean) => Promise<void>;
}

/** Each request carries its number, so a slow answer to an older one cannot overwrite a newer. */
let latest = 0;

const initial = { open: false, query: "", result: null, error: null };

export const useFind = create<FindState>((set, get) => ({
  ...initial,

  openBar: () => set({ open: true }),

  closeBar: () => {
    latest += 1;
    if (get().open) void pageTools.findClear().catch(() => {});
    set(initial);
  },

  search: async (query) => {
    const mine = ++latest;
    set({ query, error: null });
    if (!query.trim()) {
      set({ result: null });
      await pageTools.findClear().catch(() => {});
      return;
    }
    try {
      const result = await pageTools.find(query);
      if (mine === latest) set({ result });
    } catch (error) {
      if (mine === latest) set({ result: null, error: String(error) });
    }
  },

  step: async (forward) => {
    if (!get().result?.count) return;
    const mine = ++latest;
    try {
      const result = await pageTools.findStep(forward);
      if (mine === latest) set({ result, error: null });
    } catch (error) {
      if (mine === latest) set({ error: String(error) });
    }
  },
}));
