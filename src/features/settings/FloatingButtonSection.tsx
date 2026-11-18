import { useMemo } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { isMac } from "../../shared/platform";
import { formatSequence } from "../keybindings/chord";
import { effectiveBindings } from "../keybindings/keymap";
import { hasWayBack, selectFabHidden, useKeybindings } from "../keybindings/store";
import { Switch } from "./Switch";
import { Group, Section } from "./ui";

/**
 * Desktop only: shows or hides the floating button, for people who work by keys alone. It stays
 * switchable here, so a person who forgot the keys still has the way back; and it cannot be
 * hidden while no key would lead back to Settings.
 */
export function FloatingButtonSection() {
  const desktop = useApp((s) => s.desktop);
  const enabled = useKeybindings((s) => s.enabled);
  const showFab = useKeybindings((s) => s.showFab);
  const profile = useKeybindings((s) => s.profile);
  const overrides = useKeybindings((s) => s.overrides);
  const setShowFab = useKeybindings((s) => s.setShowFab);
  const t = useT();
  const mac = isMac();
  const bindings = useMemo(
    () => effectiveBindings(profile, overrides, mac),
    [profile, overrides, mac],
  );
  if (!desktop) return null;

  const hidden = selectFabHidden({ enabled, showFab });
  const stuck = !hidden && !(enabled && hasWayBack(bindings));
  const toggleKeys = bindings.get("app.fab")?.[0];

  let note = t("settings.fabOnNote");
  if (stuck) note = t("settings.fabLocked");
  else if (hidden && toggleKeys)
    note = t("settings.fabHiddenNote", { keys: formatSequence(toggleKeys, mac) });

  return (
    <Section title={t("settings.floatingButton")}>
      <Group>
        <Switch
          label={t("fab.show")}
          description={note}
          checked={!hidden}
          disabled={stuck}
          onChange={setShowFab}
        />
      </Group>
    </Section>
  );
}
