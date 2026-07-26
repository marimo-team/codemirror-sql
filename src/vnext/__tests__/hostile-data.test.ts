import { describe, expect, it } from "vitest";
import { isDataArray } from "../types.js";

describe("hostile data arrays", () => {
  it("recognizes arrays without invoking elements", () => {
    expect(isDataArray([])).toBe(true);
    expect(isDataArray({})).toBe(false);
  });

  it("contains revoked and hostile proxy traps", () => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(isDataArray(revoked.proxy)).toBe(false);
  });
});
