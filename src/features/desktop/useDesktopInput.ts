import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp, type Sheet } from "../../app/store";
import { runBackHandler } from "../back/backStack";

const MENU_SHEETS: ReadonlySet<string> = new Set<Sheet>(["assistant", "history", "settings"]);

/**
 * Mac keyboard input. Menu shortcuts (Cmd L, Cmd Y, Cmd comma) arrive as `menu:sheet` from the
 * native menu, because the page view takes the key press before the shell sees it; Escape
 * dismisses whatever is open, as Back does on mobile.
 */
export function useDesktopInput() {
  const desktop = useApp((s) => s.desktop);
  const openSheet = useApp((s) => s.openSheet);

  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<string>("menu:sheet", (event) => {
      if (MENU_SHEETS.has(event.payload)) openSheet(event.payload as Sheet);
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && runBackHandler()) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void unlisten.then((stop) => stop());
    };
  }, [desktop, openSheet]);
}
