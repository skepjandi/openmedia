import { useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { colorPick } from "../../shared/ipc";

/** How often the page is asked whether a color was tapped. */
const POLL_MS = 250;

/**
 * The color picker's prompt and result, over the page. While the layer waits it asks for a tap;
 * once the page answers it shows the color with its hex code, to copy.
 */
export function ColorPickBar() {
  const pick = useApp((s) => s.colorPick);
  const setColorPick = useApp((s) => s.setColorPick);
  const endColorPick = useApp((s) => s.endColorPick);
  const reportError = useApp((s) => s.reportError);
  const t = useT();
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const waiting = pick?.status === "waiting";

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      colorPick
        .read()
        .then((reading) => {
          if (stopped) return;
          if (reading.status === "done") setColorPick({ status: "done", hex: reading.hex });
          // No layer any more: the page changed under it, or it was cancelled.
          else if (reading.status !== "waiting") setColorPick(null);
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

  const copied = pick?.status === "done" && copiedHex === pick.hex;
  if (!pick) return null;

  return (
    <div
      data-hit=""
      role="status"
      className="glass fixed inset-x-3 top-[calc(var(--safe-top,0px)+12px)] z-[85] flex items-center gap-3 rounded-2xl px-4 py-3 text-sm text-paper"
    >
      {pick.status === "done" ? (
        <>
          <span
            aria-hidden="true"
            className="size-9 shrink-0 rounded-full border border-paper/30"
            style={{ backgroundColor: pick.hex }}
          />
          <span className="min-w-0 flex-1 font-mono text-base tracking-wide uppercase">
            {pick.hex}
          </span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard
                .writeText(pick.hex)
                .then(() => setCopiedHex(pick.hex))
                .catch(() => {});
            }}
            className="rounded-full px-3 py-1.5 font-medium text-accent active:bg-paper/[0.08]"
          >
            {t(copied ? "colorPicker.copied" : "colorPicker.copy")}
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1">{t("colorPicker.hint")}</span>
      )}
      <button
        type="button"
        onClick={endColorPick}
        className="rounded-full px-3 py-1.5 text-paper/70 active:bg-paper/[0.08]"
      >
        {t(pick.status === "done" ? "common.done" : "common.cancel")}
      </button>
    </div>
  );
}
