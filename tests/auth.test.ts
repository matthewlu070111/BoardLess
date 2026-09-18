import { describe, expect, it } from "vitest";
import { hashPassword, signSubscriptionToken, verifyPassword, verifySubscriptionToken } from "../src/worker/auth";

describe("password hashing", () => {
  it("round-trips scrypt hashes without storing the password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("accepts signed subscription tokens and rejects tampering", async () => {
    const token = await signSubscriptionToken("test-secret", "usr_test", 3);
    expect(await verifySubscriptionToken("test-secret", token)).toEqual({ userId: "usr_test", version: 3 });
    expect(await verifySubscriptionToken("test-secret", `${token.slice(0, -1)}x`)).toBeNull();
  });
});
