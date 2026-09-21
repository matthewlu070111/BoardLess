import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../src/node/database";
import { app, nodeTrafficCycle } from "../src/worker/index";
import { signSubscriptionToken } from "../src/worker/auth";
import { sha256 } from "../src/worker/db";
import type { Env } from "../src/worker/types";

const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

describe("node traffic limits", () => {
  it("clamps reset days to the end of short months in Asia/Shanghai", () => {
    const timestamp = Date.parse("2027-02-28T00:00:00+08:00") / 1000;
    expect(nodeTrafficCycle(timestamp, 31)).toEqual({
      start: timestamp,
      next: Date.parse("2027-03-31T00:00:00+08:00") / 1000,
    });
  });

  it("combines both usage tables, applies directions immediately, and keeps ownership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-node-traffic-"));
    temporaryDirectories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const ownerSession = "owner-session"; const otherSession = "other-session"; const nodeToken = "node-token";
    const config = JSON.stringify({ server: "node.example.com", port: 443, transport: "tcp", tls: true, sni: "node.example.com" });
    const manifest = JSON.stringify({ capabilities: ["nodeTrafficLimit"] });
    await db.batch([
      db.prepare("INSERT INTO users (id,email,password_hash,status,access_uuid,access_secret,created_at) VALUES ('owner','owner@example.com','x','active','owner-uuid','owner-secret',?),('other','other@example.com','x','active','other-uuid','other-secret',?),('user','user@example.com','x','active','user-uuid','user-secret',?)").bind(timestamp, timestamp, timestamp),
      db.prepare("INSERT INTO user_roles (user_id,role) VALUES ('owner','owner'),('other','admin'),('user','user')"),
      db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,'owner',?,?),(?,'other',?,?)").bind(await sha256(ownerSession), timestamp + 300, timestamp, await sha256(otherSession), timestamp + 300, timestamp),
      db.prepare("INSERT INTO backend_repositories (id,backend_id,repository_url,repository_owner,repository_name,requested_ref,commit_sha,readme_path,readme_url,readme_hash,name,version,panel_api_version,install_script,install_script_url,install_sha256,manifest_json,status,imported_by,created_at,updated_at,synced_at) VALUES ('backend','com.example.agent','https://github.com/example/agent','example','agent','v1',?,'README.md','https://raw.example/readme','hash','Agent','1','v1','scripts/install.sh','https://raw.example/install',?,?,'enabled','owner',?,?,?)").bind("a".repeat(40), "b".repeat(64), manifest, timestamp, timestamp, timestamp),
      db.prepare("INSERT INTO nodes (id,owner_admin_id,name,protocol,status,config_json,token_hash,created_at,updated_at,backend_repository_id,traffic_limit_bytes,traffic_reset_day,traffic_direction) VALUES ('node','owner','Node','vless','approved',?,?,?,?,'backend',100,1,'both')").bind(config, await sha256(nodeToken), timestamp, timestamp),
      db.prepare("INSERT INTO plans (id,name,description,price_cents,duration_days,quota_bytes,node_pool_bps,status,created_at,updated_at) VALUES ('plan','Plan','',0,30,10000,0,'active',?,?)").bind(timestamp, timestamp),
      db.prepare("INSERT INTO plan_nodes (plan_id,node_id,multiplier_bps) VALUES ('plan','node',10000)"),
      db.prepare("INSERT INTO orders (id,user_id,plan_id,status,price_cents,wallet_cents,cash_cents,expires_at,created_at) VALUES ('order','user','plan','paid',0,0,0,?,?)").bind(timestamp + 3600, timestamp),
      db.prepare("INSERT INTO entitlements (id,user_id,plan_id,order_id,starts_at,ends_at,original_seconds,price_cents,quota_bytes,node_pool_bps,status) VALUES ('ent','user','plan','order',?,?,3600,0,10000,0,'active')").bind(timestamp - 10, timestamp + 3600),
      db.prepare("INSERT INTO usage_entries (id,report_id,node_id,user_id,entitlement_id,up_bytes,down_bytes,observed_at) VALUES ('usage','r1','node','user','ent',30,10,?)").bind(timestamp),
      db.prepare("INSERT INTO direct_usage_entries (id,report_id,node_id,user_id,up_bytes,down_bytes,charged_up_bytes,charged_down_bytes,observed_at) VALUES ('direct','r2','node','user',20,50,20,50,?)").bind(timestamp),
    ]);
    const env: Env = { DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "secret", BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "" };
    const ownerHeaders = { "content-type": "application/json", cookie: `boardless_session=${ownerSession}` };
    const listed = await app.request("http://localhost/api/owner/nodes", { headers: ownerHeaders }, env);
    const listedNode = ((await listed.json()) as { nodes: Array<{ traffic: Record<string, unknown> }> }).nodes[0];
    expect(listedNode.traffic).toMatchObject({ upBytes: 50, downBytes: 60, usedBytes: 110, available: false });
    const exhausted = await app.request("http://localhost/api/node/v1/config", { headers: { authorization: `Bearer ${nodeToken}` } }, env);
    expect((await exhausted.json() as { users: unknown[] }).users).toEqual([]);
    const subscriptionToken = await signSubscriptionToken(env.SESSION_SECRET, "user", 1);
    expect((await app.request(`http://localhost/sub/${subscriptionToken}`, {}, env)).status).toBe(403);
    const finalUsage = await app.request("http://localhost/api/node/v1/usage", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${nodeToken}` }, body: JSON.stringify({ reportId: "final-delta", entries: [{ userId: "user", upBytes: 1, downBytes: 1 }] }) }, env);
    expect(await finalUsage.json()).toMatchObject({ accepted: true, entries: 1 });

    const down = await app.request("http://localhost/api/deploy/nodes/node/traffic", { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ limitBytes: 100, resetDay: 1, direction: "down" }) }, env);
    expect((await down.json() as { traffic: Record<string, unknown> }).traffic).toMatchObject({ usedBytes: 61, available: true });
    const restored = await app.request("http://localhost/api/node/v1/config", { headers: { authorization: `Bearer ${nodeToken}` } }, env);
    expect((await restored.json() as { users: unknown[] }).users).toHaveLength(1);
    expect((await app.request(`http://localhost/sub/${subscriptionToken}`, {}, env)).status).toBe(200);
    const up = await app.request("http://localhost/api/deploy/nodes/node/traffic", { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ limitBytes: 51, resetDay: 1, direction: "up" }) }, env);
    expect((await up.json() as { traffic: Record<string, unknown> }).traffic).toMatchObject({ usedBytes: 51, available: false });

    const forbidden = await app.request("http://localhost/api/deploy/nodes/node/traffic", { method: "PUT", headers: { ...ownerHeaders, cookie: `boardless_session=${otherSession}` }, body: JSON.stringify({ limitBytes: 999, resetDay: 1, direction: "both" }) }, env);
    expect(forbidden.status).toBe(404);
    database.close();
  });
});
