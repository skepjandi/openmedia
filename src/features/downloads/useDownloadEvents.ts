import { useEffect } from "react";
import { downloads } from "../../shared/ipc";
import { useDownloadsStore } from "./store";

/** Keeps the shell's list in step with the manager for as long as the app runs. */
export function useDownloadEvents(): void {
  useEffect(() => {
    const { load, apply } = useDownloadsStore.getState();
    const listening = downloads.onChanged(apply);
    void load().catch(() => undefined);
    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, []);
}
