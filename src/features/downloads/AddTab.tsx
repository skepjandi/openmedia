import { useState } from "react";
import { useT } from "../../i18n/useT";
import { downloads } from "../../shared/ipc";
import { field, primaryBlockButton } from "../settings/ui";

/** Links typed or pasted, one per line; `[001-020]` in an address stands for the whole range. */
export function AddTab({
  onAdded,
  onError,
}: {
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();

  const submit = () => {
    setBusy(true);
    downloads
      .addText(text)
      .then(
        () => {
          setText("");
          onAdded();
        },
        (error: unknown) => onError(String(error)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-paper/60">{t("downloads.addNote")}</p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="https://example.com/photo[001-010].jpg"
        aria-label={t("downloads.addTitle")}
        className={`${field} font-mono text-sm`}
      />
      <button
        type="button"
        disabled={busy || text.trim() === ""}
        onClick={submit}
        className={primaryBlockButton}
      >
        {t("downloads.addButton")}
      </button>
    </div>
  );
}
