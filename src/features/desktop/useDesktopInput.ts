import { useEffect, useMemo } from "react";
import { useApp } from "../../app/store";
import { keyboard, type MenuShortcut } from "../../shared/ipc";
import { isMac } from "../../shared/platform";
import { runBackHandler } from "../back/backStack";
import { ACTIONS, ACTIONS_BY_ID, GROUP_TITLES } from "../keybindings/actionList";
import { chordFromEvent, toAccelerator } from "../keybindings/chord";
import { isTyping } from "../keybindings/dom";
import { effectiveBindings, Matcher } from "../keybindings/keymap";
import { runAction } from "../keybindings/runActions";
import { useKeybindings } from "../keybindings/store";

/** How long a binding of several chords waits for the next one. */
const SEQUENCE_MS = 1000;

/** Each action that has a menu-safe binding, once per such binding, for the menu bar. */
function menuShortcuts(bindings: ReadonlyMap<string, readonly string[]>): MenuShortcut[] {
  const shortcuts: MenuShortcut[] = [];
  for (const info of ACTIONS) {
    let copy = 0;
    for (const sequence of bindings.get(info.id) ?? []) {
      const accelerator = toAccelerator(sequence);
      if (!accelerator) continue;
      copy += 1;
      shortcuts.push({
        id: copy === 1 ? info.id : `${info.id}#${copy}`,
        label: info.label,
        group: GROUP_TITLES[info.group],
        accelerator,
      });
    }
  }
  return shortcuts;
}

/**
 * Desktop keyboard input: every bound key runs its action, whether the shell has the keyboard
 * (here) or the page does (through the menu bar, which sees the key first). Turned off in
 * Settings, only Escape still dismisses what is open, as Back does on mobile.
 */
export function useDesktopInput() {
  const desktop = useApp((s) => s.desktop);
  const enabled = useKeybindings((s) => s.enabled);
  const profile = useKeybindings((s) => s.profile);
  const overrides = useKeybindings((s) => s.overrides);
  const mac = isMac();
  const bindings = useMemo(
    () => effectiveBindings(profile, overrides, mac),
    [profile, overrides, mac],
  );

  useEffect(() => {
    document.documentElement.toggleAttribute("data-desktop", desktop);
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void keyboard.setMenuShortcuts(enabled ? menuShortcuts(bindings) : []).catch(() => undefined);
  }, [desktop, enabled, bindings]);

  useEffect(() => {
    if (!desktop || !enabled) return;
    const unlisten = keyboard.onMenuAction((id) => {
      void runAction(id.split("#")[0], 1, "menu");
    });
    return () => void unlisten.then((stop) => stop());
  }, [desktop, enabled]);

  useEffect(() => {
    if (!desktop) return;
    if (!enabled) {
      const onEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape" && runBackHandler()) event.preventDefault();
      };
      window.addEventListener("keydown", onEscape);
      return () => window.removeEventListener("keydown", onEscape);
    }
    const matcher = new Matcher(bindings, profile);
    let timer: number | undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || useKeybindings.getState().capturing) return;
      const chord = chordFromEvent(event, mac);
      if (!chord) return;
      const press = matcher.press(chord, isTyping(event.target));
      window.clearTimeout(timer);
      if (press.kind === "none") return;
      event.preventDefault();
      if (press.kind === "pending") {
        timer = window.setTimeout(() => {
          const expired = matcher.expire();
          if (expired.kind === "run") void runAction(expired.action, expired.count);
        }, SEQUENCE_MS);
        return;
      }
      if (event.repeat && !ACTIONS_BY_ID[press.action]?.repeatable) return;
      void runAction(press.action, press.count);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [desktop, enabled, bindings, profile, mac]);
}
