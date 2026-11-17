import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  NO_LOCK,
  pauseRelaxes,
  policyRelaxes,
  refusesRelaxing,
  remainingAt,
  scheduleRelaxes,
  usageLock,
  useUsageLock,
  type LockStatus,
} from "./lock";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const policy = (warnSeconds: number | null, limitSeconds: number | null) => ({
  warnSeconds,
  limitSeconds,
});

afterEach(() => {
  vi.mocked(invoke).mockReset();
  useUsageLock.setState({ status: NO_LOCK, loaded: false });
});

describe("what the lock refuses", () => {
  it("refuses relaxing while locked or cooling off, never when off or ready", () => {
    expect(refusesRelaxing("locked")).toBe(true);
    expect(refusesRelaxing("coolingOff")).toBe(true);
    expect(refusesRelaxing("off")).toBe(false);
    expect(refusesRelaxing("ready")).toBe(false);
  });

  it("treats a higher or dropped threshold as relaxing and a lower or new one as stricter", () => {
    expect(policyRelaxes(policy(null, 600), policy(null, 300))).toBe(false);
    expect(policyRelaxes(policy(null, 600), policy(null, 601))).toBe(true);
    expect(policyRelaxes(policy(null, 600), policy(null, null))).toBe(true);
    expect(policyRelaxes(policy(300, 600), policy(null, 600))).toBe(true);
    expect(policyRelaxes(undefined, policy(null, 600))).toBe(false);
  });

  it("treats a shorter or dropped pause as relaxing", () => {
    expect(pauseRelaxes(undefined, 5)).toBe(false);
    expect(pauseRelaxes(10, 30)).toBe(false);
    expect(pauseRelaxes(10, 10)).toBe(false);
    expect(pauseRelaxes(10, 5)).toBe(true);
    expect(pauseRelaxes(10, null)).toBe(true);
  });

  it("treats a schedule that leaves a closed minute open as relaxing", () => {
    const night = { windows: [{ days: 0b1111111, startMinute: 1320, endMinute: 420 }] };
    const shorter = { windows: [{ days: 0b1111111, startMinute: 1380, endMinute: 420 }] };
    const longer = { windows: [{ days: 0b1111111, startMinute: 1260, endMinute: 480 }] };
    expect(scheduleRelaxes(night, shorter)).toBe(true);
    expect(scheduleRelaxes(night, longer)).toBe(false);
    expect(scheduleRelaxes(night, { windows: [] })).toBe(true);
    expect(scheduleRelaxes(undefined, night)).toBe(false);
  });
});

describe("the cooling-off countdown", () => {
  const cooling: LockStatus = { phase: "coolingOff", remainingSeconds: 3600, protectedOptions: [] };

  it("counts down from when the status was read and stops at zero", () => {
    expect(remainingAt(cooling, 0, 0)).toBe(3600);
    expect(remainingAt(cooling, 0, 600_500)).toBe(3000);
    expect(remainingAt(cooling, 0, 4_000_000)).toBe(0);
  });

  it("has no countdown outside cooling off", () => {
    expect(remainingAt({ ...cooling, phase: "locked" }, 0, 0)).toBe(0);
  });
});

describe("lock commands", () => {
  it("keeps the status Rust returns", async () => {
    const locked: LockStatus = { phase: "locked", remainingSeconds: 0, protectedOptions: [] };
    vi.mocked(invoke).mockResolvedValue(locked);
    await usageLock.enable();
    expect(invoke).toHaveBeenCalledWith("enable_usage_lock");
    expect(useUsageLock.getState().status).toEqual(locked);
    expect(useUsageLock.getState().loaded).toBe(true);
  });

  it("leaves the status alone when the biometric check is declined", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await usageLock.requestUnlock("why")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("request_usage_unlock", { reason: "why" });
    expect(useUsageLock.getState().loaded).toBe(false);
  });

  it("asks Rust to protect and unprotect an option", async () => {
    vi.mocked(invoke).mockResolvedValue(NO_LOCK);
    await usageLock.protect("r", "o");
    await usageLock.unprotect("r", "o");
    expect(invoke).toHaveBeenNthCalledWith(1, "protect_usage_option", {
      recipeId: "r",
      optionId: "o",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "unprotect_usage_option", {
      recipeId: "r",
      optionId: "o",
    });
  });
});
