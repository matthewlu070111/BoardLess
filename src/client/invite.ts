export type InviteRole = "user" | "admin";

export function inviteActionLabel(role: InviteRole): string {
  return role === "admin" ? "邀请管理员" : "邀请新用户";
}

export function inviteSuccessMessage(role: InviteRole): string {
  return role === "admin" ? "管理员邀请链接已复制" : "邀请链接已复制";
}
