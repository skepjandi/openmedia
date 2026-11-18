import { create } from "zustand";
import { downloads, type Download, type DownloadSettings } from "../../shared/ipc";
import { isActive, justEnded, upsert } from "./list";

/** A download that just finished or failed, announced until the user dismisses it or it times out. */
export interface Announcement {
  id: string;
  fileName: string;
  failed: boolean;
}

interface DownloadsStore {
  settings: DownloadSettings | null;
  items: Download[];
  defaultFolder: string;
  /** How many are queued or running. */
  active: number;
  /** How many ended since the list was last opened. */
  unseen: number;
  announcement: Announcement | null;
  load: () => Promise<void>;
  apply: (update: Download) => void;
  saveSettings: (settings: DownloadSettings) => Promise<DownloadSettings>;
  markSeen: () => void;
  dismissAnnouncement: () => void;
}

const countActive = (items: Download[]) => items.filter(isActive).length;

export const useDownloadsStore = create<DownloadsStore>((set, get) => ({
  settings: null,
  items: [],
  defaultFolder: "",
  active: 0,
  unseen: 0,
  announcement: null,
  load: async () => {
    const snapshot = await downloads.state();
    set({
      settings: snapshot.settings,
      items: snapshot.downloads,
      defaultFolder: snapshot.defaultFolder,
      active: countActive(snapshot.downloads),
    });
  },
  apply: (update) => {
    const { items, unseen } = get();
    const ended = justEnded(items, update);
    const next = upsert(items, update);
    set({
      items: next,
      active: countActive(next),
      unseen: ended ? unseen + 1 : unseen,
      announcement: ended
        ? { id: update.id, fileName: update.fileName, failed: update.status === "failed" }
        : get().announcement,
    });
  },
  saveSettings: async (settings) => {
    const saved = await downloads.setSettings(settings);
    set({ settings: saved });
    return saved;
  },
  markSeen: () => set({ unseen: 0 }),
  dismissAnnouncement: () => set({ announcement: null }),
}));

/** Removes a download from the local list once Rust has dropped it (events only carry updates). */
export function forget(id: string): void {
  const { items } = useDownloadsStore.getState();
  const next = items.filter((download) => download.id !== id);
  useDownloadsStore.setState({ items: next, active: countActive(next) });
}

/** Replaces the local list with what Rust holds. */
export async function refresh(): Promise<void> {
  const snapshot = await downloads.state();
  useDownloadsStore.setState({
    items: snapshot.downloads,
    active: countActive(snapshot.downloads),
  });
}
