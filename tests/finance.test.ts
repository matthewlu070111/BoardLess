import { describe, expect, it } from "vitest";
import { proratedCredit } from "../src/worker/finance";

describe("upgrade proration", () => {
  it("credits the unused time and rounds down to cents", () => {
    expect(proratedCredit(1000, 0, 100, 50)).toBe(500);
    expect(proratedCredit(999, 0, 100, 33)).toBe(669);
  });

  it("never creates credit outside the entitlement window", () => {
    expect(proratedCredit(1000, 10, 20, 20)).toBe(0);
    expect(proratedCredit(1000, 10, 20, 5)).toBe(1000);
  });
});
