import { describe, expect, it } from "vitest";
import { describeError, USAGE_LOCKED } from "./errors";
import { createTranslator } from "./translate";

describe("describeError", () => {
  const t = createTranslator("en");

  it("explains the settings lock refusal", () => {
    expect(describeError(USAGE_LOCKED, t)).toBe(t("usage.lock.refused"));
  });

  it("passes other Rust messages through", () => {
    expect(describeError("invalid usage record: invalid host", t)).toBe(
      "invalid usage record: invalid host",
    );
  });
});
