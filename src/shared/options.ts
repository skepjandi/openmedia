import type { SiteOption, OptionValue } from "./ipc";

/** Whether the setting is a list of states rather than an on/off switch. */
export function isChoiceOption(option: SiteOption): boolean {
  return option.choices.length > 0;
}

/** The value that leaves the page alone: a switch off, or the first choice. */
export function offValue(option: SiteOption): OptionValue {
  return isChoiceOption(option) ? option.choices[0].id : false;
}

/** The label of the state the option is in, for a screen reader or a summary. */
export function currentLabel(option: SiteOption): string {
  return option.choices.find((choice) => choice.id === option.value)?.label ?? "";
}

/** Whether the option currently changes the page: a switch on, or any choice but the first. */
export function isActive(option: SiteOption): boolean {
  return option.value !== offValue(option);
}
