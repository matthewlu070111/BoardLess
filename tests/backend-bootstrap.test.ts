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
    expect((await request()).status).toBe(401);
    const configResponse = await app.request("http://localhost/api/node/v1/config", { headers: { Authorization: `Bearer ${result.nodeToken}` } }, env);
    expect(configResponse.status).toBe(200);
    expect((await configResponse.json() as { users: unknown[] }).users).toEqual([]);
    database.close();
  });
});
