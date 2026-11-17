import { create } from "zustand";
import { pauseForHost, type UsageLimits } from "./policy";

/** The delays a site's pause screen offers, in seconds. */
export const PAUSE_STOPS = [5, 10, 15, 30];
export const DEFAULT_PAUSE_SECONDS = 10;

/** A session out of the reader's view this long counts as returned to, not still in use. */
export const AWAY_MS = 60_000;

/**
 * Whether a session that has just come in front gets the pause screen: when it was never in front
 * before (it was just opened), or it has been away for `AWAY_MS` or more. A session that stays in
 * front never asks again, and a brief look elsewhere (a sheet, another tab) does not count.
 */
export function needsPause(lastInFrontAt: number | null, now: number): boolean {
  return lastInFrontAt === null || now - lastInFrontAt >= AWAY_MS;
}

/** The delay a site's pause screen waits, or `null` when it shows none: no delay set, or all off. */
export function pauseDelayFor(limits: UsageLimits, host: string): number | null {
  return limits.pauseEnabled ? pauseForHost(limits.pauses, host) : null;
}

/** Whether Continue is available yet. */
export const pauseDone = (delaySeconds: number, shownSeconds: number): boolean =>
  shownSeconds >= delaySeconds;

interface PauseCover {
  /** The session whose pause screen is up, if any. Time on it is not counted as use. */
  sessionId: string | null;
}

export const usePauseCover = create<PauseCover>(() => ({ sessionId: null }));
