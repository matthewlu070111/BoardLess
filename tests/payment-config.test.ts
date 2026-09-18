import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../src/node/database";
import { openPaymentSecrets, resolveAlipayConfig, sealPaymentSecrets } from "../src/worker/payment";
import type { Env } from "../src/worker/types";

const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "boardless-payments-"));
  temporaryDirectories.push(directory);
  const database = new LocalDatabase(join(directory, "test.sqlite"));
  database.migrate(resolve("migrations"));
  const db = database.asD1();
  const env: Env = {
    DB: db, ASSETS: {} as Fetcher, APP_ORIGIN: "https://panel.example.com", SESSION_SECRET: "session-secret-for-tests",
    BOOTSTRAP_SECRET: "bootstrap", ALIPAY_APP_ID: "env-app", ALIPAY_PRIVATE_KEY: "env-private", ALIPAY_PUBLIC_KEY: "env-public",
    ALIPAY_GATEWAY: "https://openapi.alipaydev.com/gateway.do",
  };
  await db.prepare("INSERT INTO users (id, email, password_hash, status, access_uuid, access_secret, created_at) VALUES ('owner', 'owner@example.com', 'unused', 'active', 'uuid', 'secret', 1)").run();
  return { database, db, env };
}

describe("payment method configuration", () => {
  it("encrypts and decrypts payment credentials", async () => {
    const encrypted = await sealPaymentSecrets({ appId: "app", privateKey: "private", publicKey: "public" }, "secret");
    expect(encrypted).not.toContain("private");
    await expect(openPaymentSecrets(encrypted, "secret")).resolves.toEqual({ appId: "app", privateKey: "private", publicKey: "public" });
    await expect(openPaymentSecrets(encrypted, "wrong-secret")).rejects.toThrow("无法解密");
  });

  it("uses an enabled database configuration for new orders", async () => {
    const { database, db, env } = await setup();
    const ciphertext = await sealPaymentSecrets({ appId: "db-app", privateKey: "db-private", publicKey: "db-public" }, env.SESSION_SECRET);
    await db.prepare("INSERT INTO payment_methods (id, provider, display_name, enabled, config_json, secret_ciphertext, created_by, updated_by, created_at, updated_at) VALUES ('pay_alipay', 'alipay', '支付宝测试', 1, ?, ?, 'owner', 'owner', 1, 1)")
      .bind(JSON.stringify({ gateway: "https://example.com/gateway" }), ciphertext).run();
    const resolved = await resolveAlipayConfig(env);
    expect(resolved.id).toBe("pay_alipay");
    expect(resolved.config).toEqual({ appId: "db-app", privateKey: "db-private", publicKey: "db-public", gateway: "https://example.com/gateway" });
    database.close();
  });

  it("blocks new orders when disabled while preserving existing-order and environment lookups", async () => {
    const { database, db, env } = await setup();
    const ciphertext = await sealPaymentSecrets({ appId: "db-app", privateKey: "db-private", publicKey: "db-public" }, env.SESSION_SECRET);
    await db.prepare("INSERT INTO payment_methods (id, provider, display_name, enabled, config_json, secret_ciphertext, created_by, updated_by, created_at, updated_at) VALUES ('pay_alipay', 'alipay', '支付宝', 0, '{}', ?, 'owner', 'owner', 1, 1)")
      .bind(ciphertext).run();
    await expect(resolveAlipayConfig(env)).rejects.toThrow("未启用");
    expect((await resolveAlipayConfig(env, "pay_alipay")).config.appId).toBe("db-app");
    expect((await resolveAlipayConfig(env, null)).config.appId).toBe("env-app");
    database.close();
  });
});
