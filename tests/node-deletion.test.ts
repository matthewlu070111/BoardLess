import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../src/node/database";
import { app } from "../src/worker/index";
import { sha256 } from "../src/worker/db";
import type { Env } from "../src/worker/types";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("node deletion", () => {
  it("lets admins delete their nodes and requires an explicit force flag for usage history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-node-delete-"));
    directories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const adminSession = "admin-delete-session";
    const ownerSession = "owner-delete-session";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('owner', 'owner@example.com', 'x', 'owner-uuid', 'owner-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('admin', 'admin@example.com', 'x', 'admin-uuid', 'admin-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO users (id, email, password_hash, access_uuid, access_secret, created_at) VALUES ('user', 'user@example.com', 'x', 'user-uuid', 'user-secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('owner', 'owner')"),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('admin', 'admin')"),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('user', 'user')"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'admin', ?, ?)").bind(await sha256(adminSession), timestamp + 3600, timestamp),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)").bind(await sha256(ownerSession), timestamp + 3600, timestamp),
      db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES ('history-node', 'admin', 'History Node', 'shadowsocks', 'approved', '{}', 'history-token', ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES ('plain-node', 'owner', 'Plain Node', 'shadowsocks', 'pending', '{}', 'plain-token', ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plans (id, name, price_cents, duration_days, quota_bytes, created_at, updated_at) VALUES ('plan', 'Plan', 1000, 30, 10000, ?, ?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plan_nodes (plan_id, node_id) VALUES ('plan', 'history-node')"),
      db.prepare("INSERT INTO orders (id, user_id, plan_id, status, price_cents, expires_at, created_at) VALUES ('order', 'user', 'plan', 'paid', 1000, ?, ?)").bind(timestamp + 3600, timestamp),
      db.prepare("INSERT INTO entitlements (id, user_id, plan_id, order_id, starts_at, ends_at, original_seconds, price_cents, quota_bytes, node_pool_bps, status) VALUES ('entitlement', 'user', 'plan', 'order', ?, ?, 3600, 1000, 10000, 0, 'active')").bind(timestamp, timestamp + 3600),
      db.prepare("INSERT INTO user_nodes (user_id, node_id, multiplier_bps, created_at, created_by, grant_key) VALUES ('user', 'history-node', 10000, ?, 'owner', 'grant')").bind(timestamp),
      db.prepare("INSERT INTO usage_reports (report_id, node_id, reported_at) VALUES ('report', 'history-node', ?)").bind(timestamp),
      db.prepare("INSERT INTO usage_entries (id, report_id, node_id, user_id, entitlement_id, up_bytes, down_bytes, observed_at) VALUES ('usage', 'report', 'history-node', 'user', 'entitlement', 10, 20, ?)").bind(timestamp),
      db.prepare("INSERT INTO direct_usage_entries (id, report_id, node_id, user_id, up_bytes, down_bytes, charged_up_bytes, charged_down_bytes, observed_at, grant_key) VALUES ('direct-usage', 'report', 'history-node', 'user', 5, 6, 5, 6, ?, 'grant')").bind(timestamp),
    ]);
    const env: Env = { DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "secret", BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "" };
    const adminHeaders = { "content-type": "application/json", cookie: `boardless_session=${adminSession}` };
    const ownerHeaders = { "content-type": "application/json", cookie: `boardless_session=${ownerSession}` };

    const wrongOwner = await app.request("http://localhost/api/admin/nodes/plain-node", { method: "DELETE", headers: adminHeaders, body: "{}" }, env);
    expect(wrongOwner.status).toBe(404);

    const blocked = await app.request("http://localhost/api/admin/nodes/history-node", { method: "DELETE", headers: adminHeaders, body: "{}" }, env);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual(expect.objectContaining({ requiresForce: true, dependencies: expect.objectContaining({ usageEntries: 1, directUsageEntries: 1 }) }));
    expect(await db.prepare("SELECT id FROM nodes WHERE id = 'history-node'").first()).toEqual({ id: "history-node" });

    const forced = await app.request("http://localhost/api/admin/nodes/history-node?force=true", { method: "DELETE", headers: adminHeaders, body: "{}" }, env);
    expect(forced.status).toBe(200);
    expect(await db.prepare("SELECT id FROM nodes WHERE id = 'history-node'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM usage_entries WHERE node_id = 'history-node'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM direct_usage_entries WHERE node_id = 'history-node'").first()).toBeNull();
    expect(await db.prepare("SELECT action FROM audit_logs WHERE subject_id = 'history-node'").first()).toEqual({ action: "node.force_delete" });

    const ordinary = await app.request("http://localhost/api/owner/nodes/plain-node", { method: "DELETE", headers: ownerHeaders, body: "{}" }, env);
    expect(ordinary.status).toBe(200);
    expect(await db.prepare("SELECT id FROM nodes WHERE id = 'plain-node'").first()).toBeNull();
    expect(await db.prepare("SELECT action FROM audit_logs WHERE subject_id = 'plain-node'").first()).toEqual({ action: "node.delete" });
    database.close();
  });
});
