import { useEffect, useRef } from "react";
import { selectPage, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useBackHandler } from "../back/useBackHandler";
import { useT } from "../../i18n/useT";
import { CloseIcon, DownIcon, UpIcon } from "../../shared/icons";
import { MAX_FIND_QUERY_CHARS, useFind } from "./findStore";

/** How long typing pauses before the page is searched. */
const TYPING_PAUSE_MS = 150;

const step =
  "grid size-10 shrink-0 place-items-center rounded-full text-paper/80 active:bg-paper/[0.08] disabled:opacity-30";

/** Find in page: a bar over the top of the page with the match count and Previous / Next. */
export function FindBar() {
  const open = useFind((s) => s.open);
  const query = useFind((s) => s.query);
  const result = useFind((s) => s.result);
  const error = useFind((s) => s.error);
  const closeBar = useFind((s) => s.closeBar);
  const search = useFind((s) => s.search);
  const stepTo = useFind((s) => s.step);
  const pageKey = useApp((s) => {
    const page = selectPage(s);
    return page ? `${page.id}\n${page.url ?? ""}` : "";
  });
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Another page or another site: the old highlights are gone and the count means nothing.
  useEffect(() => {
    if (useFind.getState().open) closeBar();
  }, [pageKey, closeBar]);
  useBackHandler(open, closeBar);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!open) return null;

  const onChange = (text: string) => {
    useFind.setState({ query: text });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void search(text), TYPING_PAUSE_MS);
  };

  const count = result?.count ?? 0;
  const status = error
    ? describeError(error, t)
    : !query.trim()
      ? ""
      : count === 0
        ? t("find.none")
        : t("find.position", {
            index: result?.index ?? 0,
            count: result?.capped ? `${count}+` : count,
          });

  return (
    <div
      data-hit=""
      role="search"
      className="glass fixed inset-x-3 top-[calc(var(--safe-top,0px)+12px)] z-[85] flex items-center gap-1 rounded-2xl px-3 py-2 text-sm text-paper"
    >
      <input
        ref={input}
        type="search"
        value={query}
        maxLength={MAX_FIND_QUERY_CHARS}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          window.clearTimeout(timer.current);
          if (result && result.count > 0 && query === useFind.getState().query)
            void stepTo(!event.shiftKey);
          else void search(query);
        }}
        className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base text-paper outline-none placeholder:text-paper/40"
      />
      <span
        role="status"
        aria-live="polite"
        className={`shrink-0 text-xs tabular-nums ${error ? "text-warning" : "text-paper/60"}`}
      >
        {status}
      </span>
      <button
        type="button"
        aria-label={t("find.previous")}
        disabled={count === 0}
        className={step}
        onClick={() => void stepTo(false)}
      >
        <UpIcon />
      </button>
      <button
        type="button"
        aria-label={t("find.next")}
        disabled={count === 0}
        className={step}
        onClick={() => void stepTo(true)}
      >
        <DownIcon />
      </button>
      <button type="button" aria-label={t("find.close")} className={step} onClick={closeBar}>
        <CloseIcon />
      </button>
    </div>
  );
}
