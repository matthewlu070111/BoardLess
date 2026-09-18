import type { Env } from "./types";

export const now = () => Math.floor(Date.now() / 1000);
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

export function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

export function monthKey(timestamp = now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

export async function audit(
  env: Env,
  actorId: string | null,
  action: string,
  subjectType: string,
  subjectId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, action, subject_type, subject_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(newId("audit"), actorId, action, subjectType, subjectId, JSON.stringify(metadata), now()).run();
}

export async function walletBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM wallet_ledger WHERE user_id = ?")
    .bind(userId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

export async function earningsBalance(env: Env, adminId: string, at = now()): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM earnings_ledger WHERE admin_id = ? AND available_at <= ?",
  ).bind(adminId, at).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
