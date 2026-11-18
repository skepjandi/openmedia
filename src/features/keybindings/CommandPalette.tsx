import { useEffect, useMemo, useRef, useState } from "react";
import { isMac } from "../../shared/platform";
import { useBackHandler } from "../back/useBackHandler";
import { useT } from "../../i18n/useT";
import { useApp } from "../../app/store";
import { SearchIcon } from "../../shared/icons";
import { ACTIONS, GROUP_TITLES } from "./actionList";
import { formatSequence } from "./chord";
import { effectiveBindings } from "./keymap";
import { usePalette } from "./paletteStore";
import { runAction } from "./runActions";
import { useKeybindings } from "./store";

/** Every action by name, searchable; the keys that run each are shown beside it. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const desktop = useApp((s) => s.desktop);
  return open && desktop ? <PaletteBody /> : null;
}

function PaletteBody() {
  const setOpen = usePalette((s) => s.setOpen);
  const profile = useKeybindings((s) => s.profile);
  const overrides = useKeybindings((s) => s.overrides);
  const t = useT();
  const mac = isMac();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const bindings = useMemo(
    () => effectiveBindings(profile, overrides, mac),
    [profile, overrides, mac],
  );
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return ACTIONS.filter((info) => {
      const label = info.label.toLowerCase();
      return words.every((word) => label.includes(word));
    });
  }, [query]);

  useBackHandler(true, () => setOpen(false));
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (id: string) => {
    setOpen(false);
    void runAction(id);
  };
  const move = (step: number) =>
    setSelected((current) =>
      matches.length === 0 ? 0 : (current + step + matches.length) % matches.length,
    );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const control = event.ctrlKey && !event.metaKey;
    if (event.key === "ArrowDown" || (control && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (control && event.key === "p")) move(-1);
    else if (event.key === "Enter" && matches[selected]) run(matches[selected].id);
    else return;
    event.preventDefault();
  };

  return (
    <div
      data-hit=""
      onPointerDown={() => setOpen(false)}
      className="fixed inset-0 z-[90] bg-black/40"
    >
      <div
        role="dialog"
        aria-label={t("keys.palette")}
        onPointerDown={(event) => event.stopPropagation()}
        className="glass absolute inset-x-3 top-[14vh] mx-auto flex max-h-[min(34rem,70vh)] max-w-2xl flex-col overflow-hidden rounded-2xl text-paper shadow-2xl"
      >
        <div className="flex items-center gap-3 px-4">
          <span aria-hidden="true" className="text-paper/45">
            <SearchIcon />
          </span>
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("keys.palette")}
            aria-label={t("keys.palette")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-4 text-lg outline-none placeholder:text-paper/40"
          />
          <kbd className="keycap" aria-hidden="true">
            Esc
          </kbd>
        </div>
        <ul ref={list} className="min-h-0 flex-1 overflow-y-auto border-t border-hair p-1.5">
          {matches.length === 0 && (
            <li className="px-3 py-3 text-sm text-paper/55">{t("keys.paletteEmpty")}</li>
          )}
          {matches.map((info, index) => {
            const keys = bindings.get(info.id)?.[0];
            const current = index === selected;
            return (
              <li key={info.id}>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-current={current}
                  onClick={() => run(info.id)}
                  onMouseMove={() => current || setSelected(index)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm ${
                    current ? "bg-accent/15" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{info.label}</span>
                  <span className="shrink-0 text-xs text-paper/40">{GROUP_TITLES[info.group]}</span>
                  {keys && <kbd className="keycap shrink-0">{formatSequence(keys, mac)}</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
        <div
          aria-hidden="true"
          className="flex items-center gap-4 border-t border-hair px-4 py-2 text-xs text-paper/45"
        >
          <span className="flex items-center gap-1.5">
            <kbd className="keycap">↑</kbd>
            <kbd className="keycap">↓</kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="keycap">↵</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
