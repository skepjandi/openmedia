import { useEffect, useMemo, useRef, useState } from "react";
import { isMac } from "../../shared/platform";
import { useBackHandler } from "../back/useBackHandler";
import { useT } from "../../i18n/useT";
import { useApp } from "../../app/store";
import { ACTIONS } from "./actionList";
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
      role="dialog"
      aria-label={t("keys.palette")}
      className="glass fixed inset-x-3 top-[calc(var(--safe-top,0px)+12px)] z-[90] mx-auto flex max-h-[70vh] max-w-xl flex-col overflow-hidden rounded-2xl text-paper"
    >
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
        className="w-full bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-paper/40"
      />
      <ul ref={list} className="min-h-0 flex-1 overflow-y-auto border-t border-hair">
        {matches.length === 0 && (
          <li className="px-4 py-3 text-sm text-paper/55">{t("keys.paletteEmpty")}</li>
        )}
        {matches.map((info, index) => {
          const keys = bindings.get(info.id)?.[0];
          return (
            <li key={info.id}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => run(info.id)}
                onMouseEnter={() => setSelected(index)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start text-sm ${
                  index === selected ? "bg-paper/[0.1]" : ""
                }`}
              >
                <span className="min-w-0 truncate">{info.label}</span>
                {keys && (
                  <kbd className="shrink-0 font-sans text-xs text-paper/55">
                    {formatSequence(keys, mac)}
                  </kbd>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
