import { scrypt, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { base64url, fromBase64url, newId, now, randomToken, sha256 } from "./db";
import type { AppVariables, AuthUser, Env, Role } from "./types";

const SESSION_COOKIE = "boardless_session";
const SESSION_SECONDS = 60 * 60 * 24 * 14;

function scryptBuffer(password: string, salt: Uint8Array, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10 || password.length > 128) throw new Error("密码至少 10 位，最多 128 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await scryptBuffer(password, salt, 64);
  return `scrypt$16384$8$1$${base64url(salt)}$${base64url(derived)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [name, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (name !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(fromBase64url(hashValue));
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, fromBase64url(saltValue), expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function loadUser(env: Env, userId: string): Promise<AuthUser | null> {
  const row = await env.DB.prepare(
    "SELECT id, email, status, inviter_admin_id, access_uuid, access_secret, subscription_version FROM users WHERE id = ?",
  ).bind(userId).first<Record<string, unknown>>();
  if (!row) return null;
  const roleRows = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id = ?").bind(userId).all<{ role: Role }>();
  return {
    id: String(row.id), email: String(row.email), status: row.status as AuthUser["status"],
    inviterAdminId: row.inviter_admin_id ? String(row.inviter_admin_id) : null,
    accessUuid: String(row.access_uuid), accessSecret: String(row.access_secret),
    subscriptionVersion: Number(row.subscription_version), roles: roleRows.results.map((item) => item.role),
  };
}

export async function createSession(c: Context<{ Bindings: Env; Variables: AppVariables }>, userId: string) {
  const token = randomToken(32);
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now() + SESSION_SECONDS, now()).run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: SESSION_SECONDS,
  });
}

export async function destroySession(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "请先登录" }, 401);
  const session = await c.env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256(token), now()).first<{ user_id: string }>();
  if (!session) return c.json({ error: "登录已过期" }, 401);
  const user = await loadUser(c.env, session.user_id);
  if (!user || user.status !== "active") return c.json({ error: "账号不可用" }, 403);
  c.set("user", user);
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!roles.some((role) => user.roles.includes(role))) return c.json({ error: "权限不足" }, 403);
    await next();
  };
}

export async function checkLoginRate(env: Env, key: string): Promise<boolean> {
  const current = now();
  const row = await env.DB.prepare("SELECT count, window_started_at FROM login_attempts WHERE attempt_key = ?")
    .bind(key).first<{ count: number; window_started_at: number }>();
  if (!row || current - row.window_started_at >= 900) {
    await env.DB.prepare("INSERT OR REPLACE INTO login_attempts (attempt_key, count, window_started_at) VALUES (?, 1, ?)")
      .bind(key, current).run();
    return true;
  }
  if (row.count >= 10) return false;
  await env.DB.prepare("UPDATE login_attempts SET count = count + 1 WHERE attempt_key = ?").bind(key).run();
  return true;
}

export async function createUser(env: Env, email: string, password: string, role: Role, inviterId: string | null) {
  const id = newId("usr");
  const passwordHash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, password_hash, status, inviter_admin_id, access_uuid, access_secret, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)")
      .bind(id, email.trim().toLowerCase(), passwordHash, inviterId, crypto.randomUUID(), randomToken(24), now()),
    env.DB.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'user')").bind(id),
    ...(role === "user" ? [] : [env.DB.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").bind(id, role)]),
    ...(role === "admin" ? [env.DB.prepare("INSERT INTO admin_profiles (user_id) VALUES (?)").bind(id)] : []),
  ]);
  return id;
}

export async function signSubscriptionToken(secret: string, userId: string, version: number): Promise<string> {
  const payload = `${userId}.${version}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${base64url(payload)}.${base64url(new Uint8Array(signature))}`;
}

export async function verifySubscriptionToken(secret: string, token: string): Promise<{ userId: string; version: number } | null> {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;
  try {
    const payload = new TextDecoder().decode(fromBase64url(payloadPart));
    const [userId, rawVersion] = payload.split(".");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(fromBase64url(signaturePart)).buffer;
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(payload));
    if (!valid) return null;
    return { userId, version: Number(rawVersion) };
  } catch { return null; }
}
