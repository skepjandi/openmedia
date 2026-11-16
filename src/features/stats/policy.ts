import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { localDay } from "./format";

export interface UsagePolicy {
  warnSeconds: number | null;
  limitSeconds: number | null;
}

/** The limit of every site the user set one for, keyed by host. */
export type UsagePolicies = Record<string, UsagePolicy>;

/** The limit of every part of a site the user set one for, keyed by host and then by section. */
export type SectionPolicies = Record<string, UsagePolicies>;

/** Every limit the user set: for whole sites and for the parts of them. */
export interface UsageLimits {
  sites: UsagePolicies;
  sections: SectionPolicies;
}

export interface UsageControl {
  day: string;
  limits: UsageLimits;
  /** Today's seconds per site. */
  seconds: Record<string, number>;
  /** Today's seconds per part of a site. */
  sectionSeconds: Record<string, Record<string, number>>;
  ready: boolean;
  /** The heads-up the app shows over the page: a reminder, or a part that is over its limit. */
  warning: {
    host: string;
    section: string | null;
    seconds: number;
    reached: boolean;
  } | null;
}

export const useUsageControl = create<UsageControl>(() => ({
  day: localDay(new Date()),
  limits: { sites: {}, sections: {} },
  seconds: {},
  sectionSeconds: {},
  ready: false,
  warning: null,
}));

/** The stricter of two thresholds. `null` means there is no threshold, so the other one wins. */
const least = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

/** The stricter of two policies. */
const strictest = (a: UsagePolicy | undefined, b: UsagePolicy): UsagePolicy => ({
  warnSeconds: least(a?.warnSeconds ?? null, b.warnSeconds),
  limitSeconds: least(a?.limitSeconds ?? null, b.limitSeconds),
});

/** True when `site` is `host` itself or a domain around it: a parent domain or a subdomain. */
const sameSite = (host: string, site: string): boolean =>
  host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);

export function policyForHost(policies: UsagePolicies, host: string): UsagePolicy | undefined {
  // A subdomain's allowance must not bypass a configured parent-domain allowance.
  return Object.keys(policies)
    .filter((site) => sameSite(host, site))
    .map((site) => policies[site])
    .reduce<UsagePolicy | undefined>(strictest, undefined);
}

/**
 * The limit that applies to one part of a site: the strictest one among the host itself and the
 * domains around it, for the same section.
 */
export function policyForSection(
  sections: SectionPolicies,
  host: string,
  section: string,
): UsagePolicy | undefined {
  return Object.keys(sections)
    .filter((site) => sameSite(host, site))
    .map((site) => sections[site][section])
    .filter((policy): policy is UsagePolicy => policy !== undefined)
    .reduce<UsagePolicy | undefined>(strictest, undefined);
}

export function limitReached(policy: UsagePolicy | undefined, seconds: number): boolean {
  return policy?.limitSeconds != null && seconds >= policy.limitSeconds;
}

/** What closes a page today: its whole site's limit, or the limit of the part it is in. */
export type PageLock = { kind: "site" | "part"; spent: number };

/**
 * The limit that has closed the page at `target`, if any. A part's limit closes only that part;
 * the rest of the site stays open.
 */
export function pageLock(
  limits: UsageLimits,
  seconds: Record<string, number>,
  sectionSeconds: Record<string, Record<string, number>>,
  target: { host: string; section: string },
): PageLock | null {
  const site = usageSeconds(seconds, target.host);
  if (limitReached(policyForHost(limits.sites, target.host), site)) {
    return { kind: "site", spent: site };
  }
  const part = sectionUsageSeconds(sectionSeconds, target.host, target.section);
  if (limitReached(policyForSection(limits.sections, target.host, target.section), part)) {
    return { kind: "part", spent: part };
  }
  return null;
}

/** Includes a native domain's totals before a newly opened subdomain reports its scope. */
export function usageSeconds(seconds: Record<string, number>, host: string): number {
  let total = 0;
  for (const [site, value] of Object.entries(seconds)) {
    if (sameSite(host, site)) total += value;
  }
  return total;
}

/** Today's seconds in one part of a site, counting the domains around it. */
export function sectionUsageSeconds(
  sectionSeconds: Record<string, Record<string, number>>,
  host: string,
  section: string,
): number {
  let total = 0;
  for (const [site, parts] of Object.entries(sectionSeconds)) {
    if (sameSite(host, site)) total += parts[section] ?? 0;
  }
  return total;
}

export function isUsageBlocked(host: string): boolean {
  const state = useUsageControl.getState();
  return (
    state.ready &&
    limitReached(policyForHost(state.limits.sites, host), usageSeconds(state.seconds, host))
  );
}

export const usageLimits = {
  get: () => invoke<UsageLimits>("get_usage_limits"),
  setSite: async (host: string, policy: UsagePolicy): Promise<UsageLimits> => {
    const limits = await invoke<UsageLimits>("set_usage_limit", { host, policy });
    useUsageControl.setState({ limits });
    return limits;
  },
  setSection: async (host: string, section: string, policy: UsagePolicy): Promise<UsageLimits> => {
    const limits = await invoke<UsageLimits>("set_usage_section_limit", { host, section, policy });
    useUsageControl.setState({ limits });
    return limits;
  },
};
