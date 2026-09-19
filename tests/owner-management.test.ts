import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../src/node/database";
import { app } from "../src/worker/index";
import { signSubscriptionToken } from "../src/worker/auth";
import { sha256 } from "../src/worker/db";
import type { Env } from "../src/worker/types";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("owner account and node management", () => {
  it("sets wallet balance and supports plan/direct node assignments with multipliers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-owner-"));
    directories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const session = "owner-session";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('owner', 'owner@example.com', 'x', 'owner-uuid', 'owner-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('user', 'user@example.com', 'x', 'user-uuid', 'user-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('owner', 'owner')"),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('user', 'user')"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)").bind(await sha256(session), timestamp + 3600, timestamp),
      db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES ('node', 'owner', 'Hong Kong', 'shadowsocks', 'approved', ?, ?, ?, ?)").bind(JSON.stringify({ server: "node.example.com", port: 443, method: "aes-256-gcm", udp: true }), await sha256("node-token"), timestamp, timestamp),
    ]);
    const env: Env = { DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "secret", BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "" };
    const headers = { "content-type": "application/json", cookie: `boardless_session=${session}` };

    const userResponse = await app.request("http://localhost/api/owner/users/user", { method: "PATCH", headers, body: JSON.stringify({ walletCents: 12345, nodes: [{ nodeId: "node", multiplier: 2.5 }] }) }, env);
    expect(userResponse.status).toBe(200);
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM wallet_ledger WHERE user_id = 'user'").first<{ balance: number }>()).toEqual({ balance: 12345 });
    expect(await db.prepare("SELECT multiplier_bps FROM user_nodes WHERE user_id = 'user' AND node_id = 'node'").first()).toEqual({ multiplier_bps: 25000 });

    const planResponse = await app.request("http://localhost/api/owner/plans", { method: "POST", headers, body: JSON.stringify({ name: "Pro", priceCents: 1000, durationDays: 30, quotaBytes: 1024, nodes: [{ nodeId: "node", multiplier: 3 }] }) }, env);
    expect(planResponse.status).toBe(201);
    const plan = await planResponse.json() as { id: string };
    expect(await db.prepare("SELECT multiplier_bps FROM plan_nodes").first()).toEqual({ multiplier_bps: 30000 });

    await db.batch([
      db.prepare("INSERT INTO orders (id, user_id, plan_id, status, price_cents, expires_at, created_at) VALUES ('order', 'user', ?, 'paid', 1000, ?, ?)").bind(plan.id, timestamp + 3600, timestamp),
      db.prepare("INSERT INTO entitlements (id, user_id, plan_id, order_id, starts_at, ends_at, original_seconds, price_cents, quota_bytes, node_pool_bps, status) VALUES ('entitlement', 'user', ?, 'order', ?, ?, 3600, 1000, 10000, 0, 'active')").bind(plan.id, timestamp - 10, timestamp + 3600),
    ]);
    const usageResponse = await app.request("http://localhost/api/node/v1/usage", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer node-token" }, body: JSON.stringify({ reportId: "report", entries: [{ userId: "user", upBytes: 40, downBytes: 60 }] }) }, env);
    expect(usageResponse.status).toBe(200);
    expect(await db.prepare("SELECT up_bytes, down_bytes FROM quota_usage WHERE user_id = 'user'").first()).toEqual({ up_bytes: 120, down_bytes: 180 });

    const modeResponse = await app.request("http://localhost/api/owner/settings/node-authorization", { method: "PUT", headers, body: JSON.stringify({ mode: "user" }) }, env);
    expect(modeResponse.status).toBe(200);
    await db.prepare("UPDATE entitlements SET status = 'closed', closed_at = ? WHERE id = 'entitlement'").bind(timestamp).run();
    const configResponse = await app.request("http://localhost/api/node/v1/config", { headers: { authorization: "Bearer node-token" } }, env);
    expect(configResponse.status).toBe(200);
    const directConfig = await configResponse.json() as { authorizationMode: string; users: Array<{ id: string; unlimited: boolean; expiresAt: null; quotaBytes: null }> };
    expect(directConfig.authorizationMode).toBe("user");
    expect(directConfig.users).toContainEqual(expect.objectContaining({ id: "user", unlimited: true, expiresAt: null, quotaBytes: null }));
    const subscriptionToken = await signSubscriptionToken(env.SESSION_SECRET, "user", 1);
    const subscriptionResponse = await app.request(`http://localhost/sub/${subscriptionToken}?target=shadowrocket`, {}, env);
    expect(subscriptionResponse.status).toBe(200);
    expect(Buffer.from(await subscriptionResponse.text(), "base64").toString("utf8")).toContain("node.example.com");
    const directUsageResponse = await app.request("http://localhost/api/node/v1/usage", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer node-token" }, body: JSON.stringify({ reportId: "direct-report", entries: [{ userId: "user", upBytes: 40, downBytes: 60 }] }) }, env);
    expect(directUsageResponse.status).toBe(200);
    expect(await db.prepare("SELECT up_bytes, down_bytes FROM quota_usage WHERE user_id = 'user'").first()).toEqual({ up_bytes: 220, down_bytes: 330 });
    database.close();
  });
});
