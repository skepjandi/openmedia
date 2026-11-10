import { describe, expect, it } from "vitest";
import { classifyError } from "./errors";

describe("classifyError", () => {
  const kind = (e: unknown) => classifyError(e).kind;

  it("maps Rust texts to the fixed kinds", () => {
    expect(kind("The provider rejected the key.")).toBe("missingKey");
    expect(kind("no api key is saved for this provider")).toBe("missingKey");
    expect(kind("The provider is rate limiting this key. Try again shortly.")).toBe("rateLimit");
    expect(kind("Could not reach the provider.")).toBe("network");
    expect(kind("The provider's answer was not understood.")).toBe("invalid");
    expect(kind("The model's answer was not in the expected form.")).toBe("invalid");
    expect(kind("The model returned an invalid structure.")).toBe("invalid");
    expect(kind("The provider had a problem (status 500).")).toBe("provider");
    expect(kind("The change matched nothing on the page.")).toBe("nothingMatched");
    expect(kind("There is no open page.")).toBe("noPage");
    expect(kind("quux")).toBe("other");
  });

  it("never echoes unknown long text", () => {
    const long = "x".repeat(500);
    expect(classifyError(long).key).toBe("assistant.errorOther");
    expect(classifyError(long).text).toBeNull();
    expect(classifyError(new Error("boom")).text).toBe("boom");
  });

  it("names the fixed line for known kinds", () => {
    expect(classifyError("The provider rejected the key.").key).toBe("assistant.errorMissingKey");
    expect(classifyError("quux").text).toBe("quux");
  });
});
