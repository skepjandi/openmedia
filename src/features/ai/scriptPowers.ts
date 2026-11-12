import type { MessageKey } from "../../i18n/messages";
import type { Power } from "./ipc";

export type PowerTopic =
  | "network"
  | "storage"
  | "dynamicCode"
  | "markup"
  | "navigation"
  | "automation"
  | "credentials"
  | "other";

const TOPIC_OF_CODE: Record<string, PowerTopic> = {
  network: "network",
  storage: "storage",
  "dynamic-code": "dynamicCode",
  markup: "markup",
  navigation: "navigation",
  automation: "automation",
  credentials: "credentials",
};

export const POWER_KEY: Record<PowerTopic, MessageKey> = {
  network: "assistant.script.power.network",
  storage: "assistant.script.power.storage",
  dynamicCode: "assistant.script.power.dynamicCode",
  markup: "assistant.script.power.markup",
  navigation: "assistant.script.power.navigation",
  automation: "assistant.script.power.automation",
  credentials: "assistant.script.power.credentials",
  other: "assistant.script.power.other",
};

export const MAX_LINES = 5;

export interface PowerGroup {
  topic: PowerTopic;
  /** Distinct, ascending line numbers. */
  lines: number[];
}

/** Groups findings by topic, in order of first appearance; every other code is `other`. */
export function groupPowers(powers: readonly Power[]): PowerGroup[] {
  const groups = new Map<PowerTopic, Set<number>>();
  for (const power of powers) {
    const topic = TOPIC_OF_CODE[power.code] ?? "other";
    const lines = groups.get(topic) ?? new Set<number>();
    lines.add(power.line);
    groups.set(topic, lines);
  }
  return [...groups].map(([topic, lines]) => ({
    topic,
    lines: [...lines].sort((a, b) => a - b),
  }));
}

/** The first `max` lines, and whether more were left out. */
export function limitLines(
  lines: readonly number[],
  max = MAX_LINES,
): { shown: number[]; more: boolean } {
  return { shown: lines.slice(0, max), more: lines.length > max };
}
