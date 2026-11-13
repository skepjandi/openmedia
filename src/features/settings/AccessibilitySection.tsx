import { useApp } from "../../app/store";
import type { MessageKey } from "../../i18n/messages";
import { useT } from "../../i18n/useT";
import { ACCESSIBILITY_OFF } from "../../shared/accessibility";
import type { ReadingFont, Tint } from "../../shared/ipc";
import { MarginSlider } from "./MarginSlider";
import { Picker } from "./Picker";
import { Switch } from "./Switch";
import { Group, GroupLabel, Section } from "./ui";

const TINTS: { value: Tint; label: MessageKey; swatch: string | null }[] = [
  { value: "off", label: "settings.tintOff", swatch: null },
  { value: "cream", label: "settings.tintCream", swatch: "#fff0b4" },
  { value: "mint", label: "settings.tintMint", swatch: "#c8f5d7" },
  { value: "blue", label: "settings.tintBlue", swatch: "#c8e4ff" },
];

/** Font names are not translated: they are what the typeface is called. */
const FONT_NAMES: Record<Exclude<ReadingFont, "off">, string> = {
  opendyslexic: "OpenDyslexic",
  hyperlegible: "Atkinson Hyperlegible",
};

/** Epilepsy protection, the reading aids for dyslexia, and the touch aids. */
export function AccessibilitySection() {
  const accessibility = useApp((s) => s.state?.accessibility ?? ACCESSIBILITY_OFF);
  const backButton = useApp((s) => s.state?.backButton ?? false);
  const margin = useApp((s) => s.state?.bottomMargin ?? 0);
  const setAccessibility = useApp((s) => s.setAccessibility);
  const setBackButton = useApp((s) => s.setBackButton);
  const setBottomMargin = useApp((s) => s.setBottomMargin);
  const t = useT();

  return (
    <Section title={t("settings.accessibility")} note={t("settings.accessibilityNote")}>
      <Group>
        <Switch
          label={t("settings.epilepsyProtection")}
          description={t("settings.epilepsyProtectionNote")}
          checked={accessibility.epilepsyProtection}
          onChange={(on) => void setAccessibility({ epilepsyProtection: on })}
        />
      </Group>
      <div className="mt-5">
        <GroupLabel>{t("settings.dyslexia")}</GroupLabel>
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div className="text-xs text-paper/60">{t("settings.readingFont")}</div>
            <Picker
              label={t("settings.readingFont")}
              value={accessibility.font}
              options={[
                { value: "off", label: t("settings.readingFontOff") },
                ...Object.entries(FONT_NAMES).map(([value, label]) => ({ value, label })),
              ]}
              onChange={(next) => void setAccessibility({ font: next as ReadingFont })}
            />
          </div>
          <Switch
            label={t("settings.wideText")}
            description={t("settings.wideTextNote")}
            checked={accessibility.spacing}
            onChange={(on) => void setAccessibility({ spacing: on })}
          />
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div className="text-xs text-paper/60">{t("settings.tint")}</div>
            <div
              role="radiogroup"
              aria-label={t("settings.tint")}
              className="grid grid-cols-4 gap-1 rounded-2xl border border-hair bg-paper/[0.04] p-1"
            >
              {TINTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={accessibility.tint === option.value}
                  onClick={() => void setAccessibility({ tint: option.value })}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-medium ${
                    accessibility.tint === option.value
                      ? "bg-accent text-on-accent"
                      : "text-paper/75"
                  }`}
                >
                  {option.swatch && (
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-full border border-black/20"
                      style={{ backgroundColor: option.swatch }}
                    />
                  )}
                  {t(option.label)}
                </button>
              ))}
            </div>
          </div>
        </Group>
      </div>
      <div className="mt-5">
        <GroupLabel>{t("settings.touch")}</GroupLabel>
        <Group>
          <Switch
            label={t("settings.backButton")}
            description={t("settings.backButtonNote")}
            checked={backButton}
            onChange={(on) => void setBackButton(on)}
          />
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div>
              <div className="text-base">{t("settings.bottomMargin")}</div>
              <div className="mt-0.5 text-sm leading-snug text-paper/55">
                {t("settings.bottomMarginNote")}
              </div>
            </div>
            <MarginSlider
              label={t("settings.bottomMarginLabel")}
              value={margin}
              onCommit={(pixels) => void setBottomMargin(pixels)}
            />
          </div>
        </Group>
      </div>
    </Section>
  );
}
