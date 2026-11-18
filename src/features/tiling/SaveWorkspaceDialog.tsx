import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { MAX_FAVORITE_NAME_CHARS } from "../../shared/favorites";
import { useBackHandler } from "../back/useBackHandler";
import { useWorkspaceDialog } from "./workspaceDialog";

/** Names the windows as they are now and keeps them as a layout the floating button can open. */
export function SaveWorkspaceDialog() {
  const open = useWorkspaceDialog((s) => s.open);
  const desktop = useApp((s) => s.desktop);
  return open && desktop ? <DialogBody /> : null;
}

function DialogBody() {
  const t = useT();
  const close = () => useWorkspaceDialog.getState().setOpen(false);
  const layout = useApp((s) => s.layout);
  const incognito = useApp((s) => s.incognito.active);
  const saveWorkspace = useApp((s) => s.saveWorkspace);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useBackHandler(true, close);
  useEffect(() => input.current?.focus(), []);

  const blocked = incognito
    ? t("tile.saveIncognito")
    : layout === null
      ? t("tile.saveNeedsWindows")
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || busy || !name.trim()) return;
    setBusy(true);
    const saved = await saveWorkspace(name.trim());
    setBusy(false);
    if (saved) close();
  };

  return (
    <div data-hit="" onPointerDown={close} className="fixed inset-0 z-[90] bg-black/40">
      <form
        role="dialog"
        aria-label={t("tile.saveTitle")}
        onSubmit={(event) => void submit(event)}
        onPointerDown={(event) => event.stopPropagation()}
        className="glass absolute inset-x-3 top-[18vh] mx-auto flex max-w-md flex-col gap-4 rounded-2xl p-5 text-paper shadow-2xl"
      >
        <h2 className="text-base font-semibold">{t("tile.saveTitle")}</h2>
        {blocked ? (
          <p className="text-sm text-paper/65">{blocked}</p>
        ) : (
          <input
            ref={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_FAVORITE_NAME_CHARS}
            placeholder={t("tile.saveName")}
            aria-label={t("tile.saveName")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-xl border border-hair bg-transparent px-3 py-2.5 text-sm outline-none focus:border-accent"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-full border border-hair px-4 py-2 text-sm font-medium text-paper/85"
          >
            {t("common.cancel")}
          </button>
          {!blocked && (
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-on-accent disabled:opacity-40"
            >
              {t("tile.save")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
