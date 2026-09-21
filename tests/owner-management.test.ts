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

    const userResponse = await app.request("http://localhost/api/owner/users/user", { method: "PATCH", headers, body: JSON.stringify({ walletCents: 12345 }) }, env);
    expect(userResponse.status).toBe(200);
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM wallet_ledger WHERE user_id = 'user'").first<{ balance: number }>()).toEqual({ balance: 12345 });

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

    const blockedModeResponse = await app.request("http://localhost/api/owner/settings/site-mode", { method: "PUT", headers, body: JSON.stringify({ mode: "direct" }) }, env);
    expect(blockedModeResponse.status).toBe(409);
    await db.prepare("UPDATE entitlements SET status = 'closed', closed_at = ? WHERE id = 'entitlement'").bind(timestamp).run();
    const modeResponse = await app.request("http://localhost/api/owner/settings/site-mode", { method: "PUT", headers, body: JSON.stringify({ mode: "direct" }) }, env);
    expect(modeResponse.status).toBe(200);
    expect(await db.prepare("SELECT action FROM audit_logs WHERE action = 'settings.site_mode.update'").first()).toEqual({ action: "settings.site_mode.update" });
    const disabledPlanWrite = await app.request("http://localhost/api/owner/plans", { method: "POST", headers, body: JSON.stringify({ name: "Disabled", priceCents: 1, durationDays: 1, quotaBytes: 1 }) }, env);
    expect(disabledPlanWrite.status).toBe(400);
    const grantResponse = await app.request("http://localhost/api/owner/users/user/node-grants", { method: "PUT", headers, body: JSON.stringify({ grants: [{ nodeId: "node", multiplier: 2.5, expiresAt: timestamp + 7200, quotaBytes: 1000, quotaCycle: "total" }] }) }, env);
    expect(grantResponse.status).toBe(200);
    expect(await db.prepare("SELECT multiplier_bps, quota_bytes, quota_cycle FROM user_nodes WHERE user_id = 'user' AND node_id = 'node'").first()).toEqual({ multiplier_bps: 25000, quota_bytes: 1000, quota_cycle: "total" });
    const configResponse = await app.request("http://localhost/api/node/v1/config", { headers: { authorization: "Bearer node-token" } }, env);
    expect(configResponse.status).toBe(200);
    const directConfig = await configResponse.json() as { siteMode: string; users: Array<{ id: string; unlimited: boolean; expiresAt: number; quotaBytes: number; quotaCycle: string }> };
    expect(directConfig.siteMode).toBe("direct");
    expect(directConfig.users).toContainEqual(expect.objectContaining({ id: "user", unlimited: false, expiresAt: timestamp + 7200, quotaBytes: 1000, quotaCycle: "total" }));
    const subscriptionToken = await signSubscriptionToken(env.SESSION_SECRET, "user", 1);
    const subscriptionResponse = await app.request(`http://localhost/sub/${subscriptionToken}?target=shadowrocket`, {}, env);
    expect(subscriptionResponse.status).toBe(200);
    expect(Buffer.from(await subscriptionResponse.text(), "base64").toString("utf8")).toContain("node.example.com");
    const directUsageResponse = await app.request("http://localhost/api/node/v1/usage", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer node-token" }, body: JSON.stringify({ reportId: "direct-report", entries: [{ userId: "user", upBytes: 40, downBytes: 60 }] }) }, env);
    expect(directUsageResponse.status).toBe(200);
    expect(await db.prepare("SELECT up_bytes, down_bytes, charged_up_bytes, charged_down_bytes FROM direct_usage_entries WHERE user_id = 'user'").first()).toEqual({ up_bytes: 40, down_bytes: 60, charged_up_bytes: 100, charged_down_bytes: 150 });
    const blockedReturn = await app.request("http://localhost/api/owner/settings/site-mode", { method: "PUT", headers, body: JSON.stringify({ mode: "plan" }) }, env);
    expect(blockedReturn.status).toBe(409);
    await app.request("http://localhost/api/owner/users/user/node-grants", { method: "PUT", headers, body: JSON.stringify({ grants: [] }) }, env);
    const returnResponse = await app.request("http://localhost/api/owner/settings/site-mode", { method: "PUT", headers, body: JSON.stringify({ mode: "plan" }) }, env);
    expect(returnResponse.status).toBe(200);
    database.close();
  });

  it("enforces per-node direct grant periods, quota cycles, exhaustion, and re-grant resets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-direct-grants-"));
    directories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const session = "owner-direct-session";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('owner', 'owner@example.com', 'x', 'owner-uuid', 'owner-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('user', 'user@example.com', 'x', 'user-uuid', 'user-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('owner', 'owner')"),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('user', 'user')"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)").bind(await sha256(session), timestamp + 3600, timestamp),
      ...["monthly", "total", "unlimited", "expired", "planonly"].map((id) => db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES (?, 'owner', ?, 'shadowsocks', 'approved', ?, ?, ?, ?)").bind(`node_${id}`, id, JSON.stringify({ server: `${id}.example.com`, port: 443, method: "aes-256-gcm", udp: true }), `hash_${id}`, timestamp, timestamp)),
      db.prepare("UPDATE system_settings SET setting_value = 'direct' WHERE setting_key = 'site_mode'"),
    ]);
    const env: Env = { DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "secret", BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "" };
    const headers = { "content-type": "application/json", cookie: `boardless_session=${session}` };
    const save = (grants: unknown[]) => app.request("http://localhost/api/owner/users/user/node-grants", { method: "PUT", headers, body: JSON.stringify({ grants }) }, env);
    const initial = [
      { nodeId: "node_monthly", multiplier: 2, quotaBytes: 500, quotaCycle: "monthly" },
      { nodeId: "node_total", multiplier: 2.5, quotaBytes: 250, quotaCycle: "total" },
      { nodeId: "node_unlimited", multiplier: 1 },
      { nodeId: "node_expired", multiplier: 1, expiresAt: timestamp - 1 },
    ];
    expect((await save(initial)).status).toBe(200);
    await db.prepare("UPDATE user_nodes SET created_at = ? WHERE user_id = 'user'").bind(timestamp - 60 * 86400).run();
    const keys = await db.prepare("SELECT node_id, grant_key FROM user_nodes WHERE user_id = 'user'").all<{ node_id: string; grant_key: string }>();
    const key = (nodeId: string) => keys.results.find((row) => row.node_id === nodeId)!.grant_key;
    await db.batch([
      db.prepare("INSERT INTO direct_usage_entries (id, report_id, node_id, user_id, up_bytes, down_bytes, charged_up_bytes, charged_down_bytes, observed_at, grant_key) VALUES ('old-monthly', 'old-monthly', 'node_monthly', 'user', 50, 50, 50, 50, ?, ?)").bind(timestamp - 45 * 86400, key("node_monthly")),
      db.prepare("INSERT INTO direct_usage_entries (id, report_id, node_id, user_id, up_bytes, down_bytes, charged_up_bytes, charged_down_bytes, observed_at, grant_key) VALUES ('old-total', 'old-total', 'node_total', 'user', 50, 50, 50, 50, ?, ?)").bind(timestamp - 45 * 86400, key("node_total")),
    ]);
    const beforeResponse = await app.request("http://localhost/api/owner/users/user/node-grants", { headers }, env);
    const before = await beforeResponse.json() as { grants: Array<Record<string, any>> };
    expect(before.grants.find((grant) => grant.nodeId === "node_monthly")?.usedBytes).toBe(0);
    expect(before.grants.find((grant) => grant.nodeId === "node_total")?.usedBytes).toBe(100);
    expect(before.grants.find((grant) => grant.nodeId === "node_unlimited")?.active).toBe(true);
    expect(before.grants.find((grant) => grant.nodeId === "node_expired")?.active).toBe(false);

    const report = async (nodeId: string, reportId: string, upBytes: number, downBytes: number) => {
      await db.prepare("UPDATE nodes SET token_hash = ? WHERE id = ?").bind(await sha256(`${nodeId}-token`), nodeId).run();
      return app.request("http://localhost/api/node/v1/usage", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${nodeId}-token` }, body: JSON.stringify({ reportId, entries: [{ userId: "user", upBytes, downBytes }] }) }, env);
    };
    expect((await report("node_monthly", "monthly-now", 40, 60)).status).toBe(200);
    expect((await report("node_total", "total-now", 20, 40)).status).toBe(200);
    const afterResponse = await app.request("http://localhost/api/owner/users/user/node-grants", { headers }, env);
    const after = await afterResponse.json() as { grants: Array<Record<string, any>> };
    expect(after.grants.find((grant) => grant.nodeId === "node_monthly")?.usedBytes).toBe(200);
    expect(after.grants.find((grant) => grant.nodeId === "node_total")?.usedBytes).toBe(250);
    expect(after.grants.find((grant) => grant.nodeId === "node_total")?.active).toBe(false);

    const token = await signSubscriptionToken(env.SESSION_SECRET, "user", 1);
    const subscription = await app.request(`http://localhost/sub/${token}?target=shadowrocket`, {}, env);
    const decoded = Buffer.from(await subscription.text(), "base64").toString("utf8");
    expect(decoded).toContain("monthly.example.com");
    expect(decoded).toContain("unlimited.example.com");
    expect(decoded).not.toContain("total.example.com");
    expect(decoded).not.toContain("expired.example.com");
    expect(decoded).not.toContain("planonly.example.com");

    expect((await save(initial.filter((grant) => grant.nodeId !== "node_total"))).status).toBe(200);
    expect((await save(initial)).status).toBe(200);
    const regrantedResponse = await app.request("http://localhost/api/owner/users/user/node-grants", { headers }, env);
    const regranted = await regrantedResponse.json() as { grants: Array<Record<string, any>> };
    expect(regranted.grants.find((grant) => grant.nodeId === "node_total")?.usedBytes).toBe(0);
    database.close();
  });

  it("lets the owner cancel account entitlements and only delete unused plans", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-plan-cancel-"));
    directories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const session = "owner-plan-session";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('owner', 'owner@example.com', 'x', 'owner-uuid', 'owner-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('user', 'user@example.com', 'x', 'user-uuid', 'user-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('owner', 'owner')"),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('user', 'user')"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)").bind(await sha256(session), timestamp + 3600, timestamp),
      db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES ('node', 'owner', 'Node', 'shadowsocks', 'approved', '{}', 'token-hash', ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plans (id, name, price_cents, duration_days, quota_bytes, created_at, updated_at) VALUES ('used-plan', 'Used', 1000, 30, 10000, ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plans (id, name, price_cents, duration_days, quota_bytes, created_at, updated_at) VALUES ('unused-plan', 'Unused', 500, 7, 5000, ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plans (id, name, price_cents, duration_days, quota_bytes, created_at, updated_at) VALUES ('other-plan', 'Other', 500, 7, 5000, ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plan_nodes (plan_id, node_id) VALUES ('used-plan', 'node')"),
      db.prepare("INSERT INTO plan_nodes (plan_id, node_id) VALUES ('unused-plan', 'node')"),
      db.prepare("INSERT INTO orders (id, user_id, plan_id, status, price_cents, expires_at, created_at) VALUES ('current-order', 'user', 'used-plan', 'paid', 1000, ?, ?)").bind(timestamp + 3600, timestamp),
      db.prepare("INSERT INTO orders (id, user_id, plan_id, status, price_cents, expires_at, created_at) VALUES ('queued-order', 'user', 'used-plan', 'paid', 1000, ?, ?)").bind(timestamp + 3600, timestamp),
      db.prepare("INSERT INTO entitlements (id, user_id, plan_id, order_id, starts_at, ends_at, original_seconds, price_cents, quota_bytes, node_pool_bps, status) VALUES ('current-entitlement', 'user', 'used-plan', 'current-order', ?, ?, 7200, 1000, 10000, 0, 'active')").bind(timestamp - 60, timestamp + 7140),
      db.prepare("INSERT INTO entitlements (id, user_id, plan_id, order_id, starts_at, ends_at, original_seconds, price_cents, quota_bytes, node_pool_bps, status) VALUES ('queued-entitlement', 'user', 'used-plan', 'queued-order', ?, ?, 7200, 1000, 10000, 0, 'active')").bind(timestamp + 7200, timestamp + 14400),
      db.prepare("INSERT INTO orders (id, user_id, plan_id, status, price_cents, upgrade_from_entitlement_id, expires_at, created_at) VALUES ('other-order', 'user', 'other-plan', 'pending', 500, 'current-entitlement', ?, ?)").bind(timestamp + 3600, timestamp),
      db.prepare("INSERT INTO usage_entries (id, report_id, node_id, user_id, entitlement_id, up_bytes, down_bytes, observed_at) VALUES ('usage', 'report', 'node', 'user', 'current-entitlement', 10, 20, ?)").bind(timestamp),
      db.prepare("INSERT INTO wallet_ledger (id, user_id, order_id, kind, amount_cents, created_at) VALUES ('wallet', 'user', 'current-order', 'purchase', -100, ?)").bind(timestamp),
      db.prepare("INSERT INTO earnings_ledger (id, admin_id, order_id, entitlement_id, kind, amount_cents, available_at, created_at) VALUES ('earning', 'owner', 'current-order', 'current-entitlement', 'sales_commission', 50, ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO payment_events (event_key, order_id, payload_hash, created_at) VALUES ('event', 'current-order', 'hash', ?)").bind(timestamp),
      db.prepare("INSERT INTO quota_usage (user_id, month_key, up_bytes, down_bytes) VALUES ('user', '2026-09', 10, 20)"),
    ]);
    const env: Env = { DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "secret", BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "" };
    const headers = { "content-type": "application/json", cookie: `boardless_session=${session}` };

    const listResponse = await app.request("http://localhost/api/owner/users/user/entitlements", { headers }, env);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as { entitlements: Array<{ id: string; status: string }> };
    expect(listed.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "current-entitlement", status: "current" }),
      expect.objectContaining({ id: "queued-entitlement", status: "queued" }),
    ]));

    for (const id of ["current-entitlement", "queued-entitlement"]) {
      const response = await app.request(`http://localhost/api/owner/users/user/entitlements/${id}/cancel`, { method: "POST", headers, body: "{}" }, env);
      expect(response.status).toBe(200);
    }
    expect(await db.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'closed' AND close_reason = 'owner_cancel'").first()).toEqual({ count: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = 'owner' AND action = 'entitlement.owner_cancel'").first()).toEqual({ count: 2 });

    const blockedDelete = await app.request("http://localhost/api/owner/plans/used-plan", { method: "DELETE", headers, body: "{}" }, env);
    expect(blockedDelete.status).toBe(409);
    expect(await blockedDelete.json()).toEqual(expect.objectContaining({ requiresForce: true, dependencies: expect.objectContaining({ orders: 2, entitlements: 2, usageEntries: 1, walletEntries: 1, earningsEntries: 1, paymentEvents: 1 }) }));
    expect(await db.prepare("SELECT id FROM plans WHERE id = 'used-plan'").first()).toEqual({ id: "used-plan" });
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM wallet_ledger WHERE user_id = 'user'").first()).toEqual({ balance: -100 });
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM earnings_ledger WHERE admin_id = 'owner'").first()).toEqual({ balance: 50 });

    const forceDelete = await app.request("http://localhost/api/owner/plans/used-plan?force=true", { method: "DELETE", headers, body: "{}" }, env);
    expect(forceDelete.status).toBe(200);
    expect(await db.prepare("SELECT id FROM plans WHERE id = 'used-plan'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM orders WHERE plan_id = 'used-plan'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM entitlements WHERE plan_id = 'used-plan'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM usage_entries WHERE id = 'usage'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM wallet_ledger WHERE id = 'wallet'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM earnings_ledger WHERE id = 'earning'").first()).toBeNull();
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM wallet_ledger WHERE user_id = 'user'").first()).toEqual({ balance: null });
    expect(await db.prepare("SELECT SUM(amount_cents) AS balance FROM earnings_ledger WHERE admin_id = 'owner'").first()).toEqual({ balance: null });
    expect(await db.prepare("SELECT event_key FROM payment_events WHERE event_key = 'event'").first()).toBeNull();
    expect(await db.prepare("SELECT upgrade_from_entitlement_id FROM orders WHERE id = 'other-order'").first()).toEqual({ upgrade_from_entitlement_id: null });
    expect(await db.prepare("SELECT up_bytes, down_bytes FROM quota_usage WHERE user_id = 'user' AND month_key = '2026-09'").first()).toEqual({ up_bytes: 10, down_bytes: 20 });
    expect(await db.prepare("SELECT action FROM audit_logs WHERE subject_id = 'used-plan' ORDER BY created_at DESC LIMIT 1").first()).toEqual({ action: "plan.force_delete" });

    const deleteResponse = await app.request("http://localhost/api/owner/plans/unused-plan", { method: "DELETE", headers, body: "{}" }, env);
    expect(deleteResponse.status).toBe(200);
    expect(await db.prepare("SELECT id FROM plans WHERE id = 'unused-plan'").first()).toBeNull();
    expect(await db.prepare("SELECT plan_id FROM plan_nodes WHERE plan_id = 'unused-plan'").first()).toBeNull();
    expect(await db.prepare("SELECT action FROM audit_logs WHERE subject_id = 'unused-plan'").first()).toEqual({ action: "plan.delete" });
    database.close();
  });
});
