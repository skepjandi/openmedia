import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isContainedIn, type Schedule } from "./schedule";
import type { UsagePolicy } from "./policy";

/**
 * The settings lock: while it is on, limits, schedules, pause screens and protected recipe options
 * can be made stricter but not relaxed. Rust owns the state and the 24 hour cooling-off timestamp
 * (`usage_lock.rs`) and refuses a relaxation itself; the shell mirrors the rules below only to say
 * so before asking.
 */
export type LockPhase = "off" | "locked" | "coolingOff" | "ready";

export interface ProtectedOption {
  recipeId: string;
  optionId: string;
}

export interface LockStatus {
  phase: LockPhase;
  /** Seconds of cooling-off left when `phase` is `coolingOff`; otherwise 0. */
  remainingSeconds: number;
  protectedOptions: ProtectedOption[];
}

export const NO_LOCK: LockStatus = { phase: "off", remainingSeconds: 0, protectedOptions: [] };

interface UsageLockStore {
  status: LockStatus;
  /** When `status` was read, so the countdown can run without asking Rust every second. */
  readAt: number;
  loaded: boolean;
}

export const useUsageLock = create<UsageLockStore>(() => ({
  status: NO_LOCK,
  readAt: Date.now(),
  loaded: false,
}));

function adopt(status: LockStatus): LockStatus {
  useUsageLock.setState({ status, readAt: Date.now(), loaded: true });
  return status;
}

/** Each call returns the new status; a `null` means the biometric check was declined. */
export const usageLock = {
  load: async () => adopt(await invoke<LockStatus>("get_usage_lock")),
  enable: async () => adopt(await invoke<LockStatus>("enable_usage_lock")),
  requestUnlock: async (reason: string) => {
    const status = await invoke<LockStatus | null>("request_usage_unlock", { reason });
    return status && adopt(status);
  },
  cancelUnlock: async (reason: string) => {
    const status = await invoke<LockStatus | null>("cancel_usage_unlock", { reason });
    return status && adopt(status);
  },
  lift: async () => adopt(await invoke<LockStatus>("lift_usage_lock")),
  protect: async (recipeId: string, optionId: string) =>
    adopt(await invoke<LockStatus>("protect_usage_option", { recipeId, optionId })),
  unprotect: async (recipeId: string, optionId: string) =>
    adopt(await invoke<LockStatus>("unprotect_usage_option", { recipeId, optionId })),
};

/** Whether the lock refuses relaxations right now: locked, or still cooling off. */
export const refusesRelaxing = (phase: LockPhase): boolean =>
  phase === "locked" || phase === "coolingOff";

/** The cooling-off seconds left, counted down from when the status was read. */
export function remainingAt(status: LockStatus, readAt: number, now: number): number {
  if (status.phase !== "coolingOff") return 0;
  return Math.max(0, status.remainingSeconds - Math.floor((now - readAt) / 1000));
}

/** A higher or dropped threshold: more use than before. */
const thresholdRelaxes = (old: number | null, next: number | null): boolean =>
  old !== null && (next === null || next > old);

/** A policy that allows more than the old one did; a site with no policy cannot be relaxed. */
export function policyRelaxes(old: UsagePolicy | undefined, next: UsagePolicy): boolean {
  return (
    old !== undefined &&
    (thresholdRelaxes(old.warnSeconds, next.warnSeconds) ||
      thresholdRelaxes(old.limitSeconds, next.limitSeconds))
  );
}

/** A schedule that leaves the site open at some time the old one closed it. */
export function scheduleRelaxes(old: Schedule | undefined, next: Schedule): boolean {
  return old !== undefined && !isContainedIn(old, next);
}

/** A shorter or dropped pause delay: less friction than before. */
export function pauseRelaxes(old: number | undefined, next: number | null): boolean {
  return old !== undefined && (next === null || next < old);
}
