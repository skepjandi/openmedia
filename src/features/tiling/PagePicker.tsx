import { useEffect, useMemo, useRef, useState } from "react";
import { selectPage, selectQuickFavorites, useApp, type DroppedPage } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { displayHost } from "../../shared/favorites";
import { SearchIcon } from "../../shared/icons";
import { iconForUrl } from "../../shared/siteIcons";
import { normalizeWebUrl } from "../../shared/url";
import { useBackHandler } from "../back/useBackHandler";
import type { Side } from "./layout";

const PROMPTS = {
  right: "tile.pickRight",
  left: "tile.pickLeft",
  top: "tile.pickAbove",
  bottom: "tile.pickBelow",
} as const satisfies Record<Side, MessageKey>;

interface Choice {
  key: string;
  name: string;
  host: string;
  icon?: string;
  kind: "address" | "favorite" | "open";
  page: DroppedPage;
}

/**
 * The palette's second step for adding a window: which page goes in it. Favorites, the pages that
 * are open, and any address typed; the page opens on the chosen side of the window in front.
 */
export function PagePicker({ side, onClose }: { side: Side; onClose: () => void }) {
  const t = useT();
  const favorites = useApp(selectQuickFavorites);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);
  const showing = useApp((s) => selectPage(s) !== null);
  const dropPage = useApp((s) => s.dropPage);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useBackHandler(true, onClose);
  useEffect(() => input.current?.focus(), []);

  const choices = useMemo(() => {
    const all: Choice[] = [
      ...favorites.map((favorite): Choice => ({
        key: `favorite:${favorite.id}`,
        name: favorite.name,
        host: displayHost(favorite.url),
        icon: favorite.icon,
        kind: "favorite",
        page: { kind: "favorite", favorite },
      })),
      ...sessions
        .filter((session) => session.id !== activeId)
        .map((session): Choice => {
          const url = session.url ?? session.openedUrl;
          return {
            key: `open:${session.id}`,
            name: session.title?.trim() || displayHost(url),
            host: displayHost(url),
            icon: iconForUrl(url, favorites),
            kind: "open",
            page: { kind: "session", id: session.id },
          };
        }),
    ];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = all.filter((choice) =>
      words.every((word) => `${choice.name} ${choice.host}`.toLowerCase().includes(word)),
    );
    const address = query.trim() ? normalizeWebUrl(query.trim()) : null;
    return address
      ? [
          {
            key: "address",
            name: t("tile.pickOpen", { address: displayHost(address) }),
            host: address,
            kind: "address",
            page: { kind: "address", url: address },
          } satisfies Choice,
          ...matching,
        ]
      : matching;
  }, [favorites, sessions, activeId, query, t]);

  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (choice: Choice) => {
    onClose();
    dropPage(choice.page, showing ? activeId : null, side);
  };
  const move = (step: number) =>
    setSelected((current) =>
      choices.length === 0 ? 0 : (current + step + choices.length) % choices.length,
    );
  const onKeyDown = (event: React.KeyboardEvent) => {
    const control = event.ctrlKey && !event.metaKey;
    if (event.key === "ArrowDown" || (control && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (control && event.key === "p")) move(-1);
    else if (event.key === "Enter" && choices[selected]) choose(choices[selected]);
    else return;
    event.preventDefault();
  };

  return (
    <div data-hit="" onPointerDown={onClose} className="fixed inset-0 z-[90] bg-black/40">
      <div
        role="dialog"
        aria-label={t(PROMPTS[side])}
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
            placeholder={t(PROMPTS[side])}
            aria-label={t(PROMPTS[side])}
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
          {choices.length === 0 && (
            <li className="px-3 py-3 text-sm text-paper/55">{t("tile.pickEmpty")}</li>
          )}
          {choices.map((choice, index) => (
            <li key={choice.key}>
              <button
                type="button"
                tabIndex={-1}
                aria-current={index === selected}
                onClick={() => choose(choice)}
                onMouseMove={() => index === selected || setSelected(index)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm ${
                  index === selected ? "bg-accent/15" : ""
                }`}
              >
                {choice.icon ? (
                  <img src={choice.icon} alt="" className="size-5 shrink-0 rounded-md" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="grid size-5 shrink-0 place-items-center rounded-md bg-paper/15 text-[10px] font-semibold uppercase"
                  >
                    {choice.name.charAt(0)}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                <span className="max-w-[40%] shrink-0 truncate text-xs text-paper/40">
                  {choice.host}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
