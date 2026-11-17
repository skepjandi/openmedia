import { useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { hexToRgbText } from "../../shared/color";
import { colorPick } from "../../shared/ipc";

/** How often the page is asked for the color under the loupe. */
const POLL_MS = 250;

/**
 * The color picker's controls, over the page. While the loupe is up it shows the color under it
 * with Cancel and Accept; once accepted it shows the chosen color, to copy as hex or `rgb()`.
 */
export function ColorPickBar() {
  const pick = useApp((s) => s.colorPick);
  const setColorPick = useApp((s) => s.setColorPick);
  const endColorPick = useApp((s) => s.endColorPick);
  const acceptColorPick = useApp((s) => s.acceptColorPick);
  const reportError = useApp((s) => s.reportError);
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const waiting = pick?.status === "waiting";

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      colorPick
        .read()
        .then((reading) => {
          if (stopped) return;
          if (reading.status === "waiting") setColorPick(reading);
          // No loupe any more: the page changed under it, or it was cancelled.
          else setColorPick(null);
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setColorPick(null);
          reportError(appError(error));
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, setColorPick, reportError]);

  if (!pick) return null;

  const hex = pick.hex;
  const rgb = hex && hexToRgbText(hex);
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(text))
      .catch(() => {});
  };
  const swatch = (
    <span
      aria-hidden="true"
      className="size-9 shrink-0 rounded-full border border-paper/30"
      style={hex ? { backgroundColor: hex } : undefined}
    />
  );
  const values = (
    <span className="flex min-w-0 flex-col">
      <span className="font-mono text-base tracking-wide uppercase">{hex ?? "#——————"}</span>
      {rgb && <span className="font-mono text-xs text-paper/70">{rgb}</span>}
    </span>
  );

  return (
    <div
      data-hit=""
      role="status"
      className="glass fixed inset-x-3 top-[calc(var(--safe-top,0px)+12px)] z-[85] flex flex-col gap-2 rounded-2xl px-4 py-3 text-sm text-paper"
    >
      <div className="flex items-center gap-3">
        {swatch}
        {values}
        {pick.status === "waiting" && (
          <span className="min-w-0 flex-1 text-paper/70">{t("colorPicker.hint")}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {pick.status === "done" ? (
          <>
            {rgb && (
              <button
                type="button"
                onClick={() => copy(rgb)}
                className="rounded-full px-3 py-1.5 text-paper/70 active:bg-paper/[0.08]"
              >
                {t(copied === rgb ? "colorPicker.copied" : "colorPicker.copyRgb")}
              </button>
            )}
            <button
              type="button"
              onClick={() => copy(pick.hex)}
              className="rounded-full px-3 py-1.5 font-medium text-accent active:bg-paper/[0.08]"
            >
              {t(copied === pick.hex ? "colorPicker.copied" : "colorPicker.copy")}
            </button>
            <button
              type="button"
              onClick={endColorPick}
              className="rounded-full px-3 py-1.5 text-paper/70 active:bg-paper/[0.08]"
            >
              {t("common.done")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={endColorPick}
              className="rounded-full px-3 py-1.5 text-paper/70 active:bg-paper/[0.08]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={!hex}
              onClick={() => void acceptColorPick()}
              className="rounded-full px-3 py-1.5 font-medium text-accent active:bg-paper/[0.08] disabled:opacity-40"
            >
              {t("colorPicker.accept")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
