import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../src/node/database";
import { app } from "../src/worker/index";
import { sha256 } from "../src/worker/db";
import type { Env } from "../src/worker/types";

const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

describe("node installation bootstrap", () => {
  it("builds install arguments from backend-provided input metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-install-command-"));
    temporaryDirectories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const sessionToken = "owner-session-token";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, status, access_uuid, access_secret, created_at) VALUES ('usr_owner', 'owner@example.com', 'unused', 'active', 'uuid', 'secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('usr_owner', 'owner')"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 'usr_owner', ?, ?)").bind(await sha256(sessionToken), timestamp + 300, timestamp),
      db.prepare("INSERT INTO backend_repositories (id, backend_id, repository_url, repository_owner, repository_name, requested_ref, commit_sha, readme_path, readme_url, readme_hash, name, version, panel_api_version, install_script, install_script_url, install_sha256, manifest_json, status, imported_by, created_at, updated_at, synced_at) VALUES ('backend_1', 'com.example.agent', 'https://github.com/example/agent', 'example', 'agent', 'v1', ?, 'README.md', 'https://raw.example/readme', 'hash', 'Agent', '1.0.0', 'v1', 'scripts/install.sh', 'https://raw.example/install', ?, '{}', 'enabled', 'usr_owner', ?, ?, ?)").bind("a".repeat(40), "b".repeat(64), timestamp, timestamp, timestamp),
      db.prepare("INSERT INTO backend_presets (backend_repository_id, preset_id, name, protocol, description, config_json, required_inputs_json, generated_outputs_json) VALUES ('backend_1', 'tls', 'TLS', 'vless', '', ?, ?, '[]')")
        .bind(JSON.stringify({ server: "{{ input.server }}", port: 443, transport: "tcp", tls: true, sni: "{{ input.server }}" }), JSON.stringify([
          { key: "server", label: "节点域名", type: "hostname", installArg: "--domain" },
          { key: "enableVps", label: "同步 VPS Panel", type: "checkbox", required: false, default: "false", installArg: "--mode", checkedValue: "both", uncheckedValue: "boardless" },
          { key: "vpsUrl", label: "VPS Panel 地址", type: "url", installArg: "--vps-panel-url", when: { key: "enableVps", equals: "true" } },
          { key: "vpsToken", label: "注册令牌", type: "password", sensitive: true, installArg: "--vps-enrollment-token", when: { key: "enableVps", equals: "true" } },
        ])),
    ]);
    const env: Env = {
      DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "test-session-secret",
      BOOTSTRAP_SECRET: "test-bootstrap-secret", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "",
    };
    const headers = { "content-type": "application/json", cookie: `boardless_session=${sessionToken}` };
    const createdResponse = await app.request("http://localhost/api/deploy/nodes", {
      method: "POST", headers, body: JSON.stringify({ backendId: "com.example.agent", presetId: "tls", name: "Node", inputs: { server: "node.example.com", enableVps: "true", vpsUrl: "https://vps.example.com", vpsToken: "one-time-secret" } }),
    }, env);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { node: { id: string } };
    const commandResponse = await app.request(`http://localhost/api/deploy/nodes/${created.node.id}/install-command`, { method: "POST", headers, body: JSON.stringify({ inputs: { server: "node.example.com", enableVps: "true", vpsUrl: "https://vps.example.com", vpsToken: "one-time-secret" } }) }, env);
    expect(commandResponse.status).toBe(200);
    const result = await commandResponse.json() as { command: string };
    expect(result.command).toContain("'--domain' 'node.example.com'");
    expect(result.command).toContain("'--mode' 'both'");
    expect(result.command).toContain("'--vps-panel-url' 'https://vps.example.com'");
    expect(result.command).toContain("'--vps-enrollment-token' 'one-time-secret'");
    const saved = await db.prepare("SELECT inputs_json, expires_at, created_at FROM node_install_tokens WHERE node_id = ?").bind(created.node.id)
      .first<{ inputs_json: string; expires_at: number; created_at: number }>();
    expect(JSON.parse(saved!.inputs_json)).toEqual({ server: "node.example.com", enableVps: "true", vpsUrl: "https://vps.example.com" });
    expect(saved!.expires_at - saved!.created_at).toBe(30 * 60);
    const node = await db.prepare("SELECT backend_inputs_json FROM nodes WHERE id = ?").bind(created.node.id).first<{ backend_inputs_json: string }>();
    expect(JSON.parse(node!.backend_inputs_json).vpsToken).toBe("");
    database.close();
  });

  it("exchanges a one-time install token for a formal node token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boardless-bootstrap-"));
    temporaryDirectories.push(directory);
    const database = new LocalDatabase(join(directory, "test.sqlite"));
    database.migrate(resolve("migrations"));
    const db = database.asD1();
    const timestamp = Math.floor(Date.now() / 1000);
    const installToken = "install-token-for-test";
    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, status, access_uuid, access_secret, created_at) VALUES ('usr_admin', 'admin@example.com', 'unused', 'active', 'uuid', 'secret', ?)").bind(timestamp),
      db.prepare("INSERT INTO backend_repositories (id, backend_id, repository_url, repository_owner, repository_name, requested_ref, commit_sha, readme_path, readme_url, readme_hash, name, version, panel_api_version, install_script, install_script_url, install_sha256, manifest_json, status, imported_by, created_at, updated_at, synced_at) VALUES ('backend_1', 'com.example.agent', 'https://github.com/example/agent', 'example', 'agent', 'v1', ?, 'README.md', 'https://raw.example/readme', 'hash', 'Agent', '1.0.0', 'v1', 'scripts/install.sh', 'https://raw.example/install', ?, '{}', 'enabled', 'usr_admin', ?, ?, ?)").bind("a".repeat(40), "b".repeat(64), timestamp, timestamp, timestamp),
      db.prepare("INSERT INTO backend_presets (backend_repository_id, preset_id, name, protocol, description, config_json, required_inputs_json, generated_outputs_json) VALUES ('backend_1', 'reality', 'Reality', 'vless', '', ?, '[\"server\"]', '[\"realityPublicKey\"]')").bind(JSON.stringify({ server: "node.example.com", port: 443, transport: "tcp", tls: true, sni: "node.example.com", realityPublicKey: "{{ generated.realityPublicKey }}" })),
      db.prepare("INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at, backend_repository_id, backend_preset_id) VALUES ('node_1', 'usr_admin', 'Node', 'vless', 'pending', ?, 'unused', ?, ?, 'backend_1', 'reality')").bind(JSON.stringify({ server: "node.example.com", port: 443, transport: "tcp", tls: true, sni: "node.example.com", realityPublicKey: "{{ generated.realityPublicKey }}" }), timestamp, timestamp),
      db.prepare("INSERT INTO node_install_tokens (id, token_hash, node_id, backend_repository_id, preset_id, inputs_json, expires_at, created_by, created_at) VALUES ('install_1', ?, 'node_1', 'backend_1', 'reality', '{}', ?, 'usr_admin', ?)").bind(await sha256(installToken), timestamp + 300, timestamp),
    ]);
    const env: Env = {
      DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "test-session-secret",
      BOOTSTRAP_SECRET: "test-bootstrap-secret", ALIPAY_APP_ID: "", ALIPAY_PRIVATE_KEY: "", ALIPAY_PUBLIC_KEY: "", ALIPAY_GATEWAY: "",
    };
    const request = () => app.request("http://localhost/api/node/v1/bootstrap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ installToken, generatedOutputs: { realityPublicKey: "public-key" }, agentVersion: "agent/1.0.0" }),
    }, env);
    const response = await request();
    expect(response.status).toBe(200);
    const result = await response.json() as { nodeToken: string; config: Record<string, unknown> };
    expect(result.nodeToken).toBeTruthy();
    expect(result.config.realityPublicKey).toBe("public-key");
    const reusedResponse = await request();
    expect(reusedResponse.status).toBe(401);
    expect(await reusedResponse.json()).toEqual({ error: "安装令牌已被使用，请重新生成安装命令" });
    await db.prepare("UPDATE node_install_tokens SET used_at = NULL, expires_at = ? WHERE id = 'install_1'").bind(timestamp - 1).run();
    const expiredResponse = await request();
    expect(expiredResponse.status).toBe(401);
    expect(await expiredResponse.json()).toEqual({ error: "安装令牌已过期，请重新生成安装命令" });
    const configResponse = await app.request("http://localhost/api/node/v1/config", { headers: { Authorization: `Bearer ${result.nodeToken}` } }, env);
    expect(configResponse.status).toBe(200);
    expect((await configResponse.json() as { users: unknown[] }).users).toEqual([]);
    database.close();
  });
});
