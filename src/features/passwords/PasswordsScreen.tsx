import { useEffect, useRef, useState } from "react";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { vault, type VaultLogin } from "../../shared/ipc";
import { BiometricIcon } from "../incognito/BiometricIcon";
import { Group, dangerButton, primaryBlockButton, quietButton } from "../settings/ui";

/** How long a shown password stays on screen. */
const SHOWN_MS = 15_000;

/** The imported logins, behind the device owner check. Passwords show only when asked, briefly. */
export function PasswordsScreen() {
  const open = useApp((s) => s.sheet === "passwords");
  const parent = useApp((s) => s.sheetParent);
  const closeSheet = useApp((s) => s.closeSheet);
  const t = useT();
  const [logins, setLogins] = useState<VaultLogin[] | null>(null);
  const [shown, setShown] = useState<{ id: string; password: string } | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hide = useRef<number | undefined>(undefined);

  const lock = () => {
    window.clearTimeout(hide.current);
    setShown(null);
    setLogins(null);
    setConfirmingAll(false);
    void vault.lock().catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    return () => {
      window.clearTimeout(hide.current);
      void vault.lock().catch(() => {});
    };
  }, [open]);

  if (!open) return null;

  const fail = (failure: unknown) => {
    const text = describeError(failure, t);
    if (text === "vault-locked") lock();
    else setError(text);
  };

  const unlock = async () => {
    setError(null);
    try {
      if (await vault.unlock(t("passwords.unlockReason"))) setLogins(await vault.list());
    } catch (failure) {
      fail(failure);
    }
  };

  const show = async (login: VaultLogin) => {
    window.clearTimeout(hide.current);
    if (shown?.id === login.id) {
      setShown(null);
      return;
    }
    try {
      setShown({ id: login.id, password: await vault.reveal(login.id) });
      hide.current = window.setTimeout(() => setShown(null), SHOWN_MS);
    } catch (failure) {
      fail(failure);
    }
  };

  const remove = async (login: VaultLogin) => {
    try {
      await vault.remove(login.id);
      setShown(null);
      setLogins(await vault.list());
    } catch (failure) {
      fail(failure);
    }
  };

  const clearAll = async () => {
    try {
      await vault.clear();
      lock();
      setLogins([]);
    } catch (failure) {
      fail(failure);
    }
  };

  return (
    <Screen
      title={t("passwords.title")}
      closeLabel={t(parent === "settings" ? "common.back" : "passwords.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <div className="flex flex-col gap-5">
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {logins === null ? (
          <button type="button" className={primaryBlockButton} onClick={() => void unlock()}>
            <BiometricIcon />
            {t("passwords.unlock")}
          </button>
        ) : logins.length === 0 ? (
          <p className="text-sm text-paper/65">{t("passwords.empty")}</p>
        ) : (
          <>
            <Group>
              {logins.map((login) => (
                <div key={login.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <span className="block truncate text-base font-medium">{login.site}</span>
                    <span className="block truncate text-sm text-paper/55">
                      {login.username || login.origin}
                    </span>
                  </div>
                  {shown?.id === login.id && (
                    <code className="rounded-lg bg-paper/[0.06] px-3 py-2 text-sm break-all select-all">
                      {shown.password}
                    </code>
                  )}
                  <div className="flex gap-2">
                    <button type="button" className={quietButton} onClick={() => void show(login)}>
                      {t(shown?.id === login.id ? "passwords.hide" : "passwords.show")}
                    </button>
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => void remove(login)}
                    >
                      {t("passwords.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </Group>
            {confirmingAll ? (
              <div role="alert" className="flex flex-col gap-3 rounded-2xl bg-paper/[0.05] p-4">
                <p className="text-sm text-paper/80">{t("passwords.deleteAllConfirm")}</p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => setConfirmingAll(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button type="button" className={dangerButton} onClick={() => void clearAll()}>
                    {t("passwords.deleteAll")}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={quietButton} onClick={() => setConfirmingAll(true)}>
                {t("passwords.deleteAll")}
              </button>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}
