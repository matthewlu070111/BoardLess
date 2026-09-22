import { describe, expect, it } from "vitest";
import { inviteActionLabel, inviteSuccessMessage } from "../src/client/invite";

describe("invite button helpers", () => {
  it("uses role-specific labels for owner and admin invite actions", () => {
    expect(inviteActionLabel("user")).toBe("邀请新用户");
    expect(inviteActionLabel("admin")).toBe("邀请管理员");
  });

  it("renders a role-aware success notice", () => {
    expect(inviteSuccessMessage("user")).toContain("邀请链接已复制");
    expect(inviteSuccessMessage("admin")).toContain("管理员邀请链接已复制");
  });
});
