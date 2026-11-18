import { describe, expect, it } from "vitest";
import { formatBytes, formatEta, formatSpeed } from "./format";

describe("formatBytes", () => {
  it("scales to the largest unit that keeps the number small", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(250_000)).toBe("250 KB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
  });

  it("treats a negative size as nothing", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatSpeed and formatEta", () => {
  it("writes a speed per second", () => {
    expect(formatSpeed(1_200_000)).toBe("1.2 MB/s");
  });

  it("writes the time left in the two largest units", () => {
    expect(formatEta(45, 1)).toBe("45s");
    expect(formatEta(200, 1)).toBe("3m 20s");
    expect(formatEta(3900, 1)).toBe("1h 05m");
  });

  it("has no estimate without speed or without anything left", () => {
    expect(formatEta(100, 0)).toBeNull();
    expect(formatEta(0, 10)).toBeNull();
  });
});
