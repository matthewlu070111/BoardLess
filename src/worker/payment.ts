import { createSign, createVerify } from "node:crypto";
import QRCode from "qrcode";
import type { Env } from "./types";

export interface AlipayConfig {
  appId: string;
  privateKey: string;
  publicKey: string;
  gateway: string;
}

export interface ResolvedAlipayConfig {
  id: string | null;
  name: string;
  config: AlipayConfig;
  source: "database" | "environment";
}

interface PaymentMethodRow {
  id: string;
  display_name: string;
  enabled: number;
  config_json: string;
  secret_ciphertext: string;
}

function key(value: string): string { return value.replaceAll("\\n", "\n").trim(); }

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`boardless:payments:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealPaymentSecrets(value: Record<string, string>, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function openPaymentSecrets(value: string, secret: string): Promise<Record<string, string>> {
  const [version, encodedIv, encodedPayload] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedPayload) throw new Error("支付配置密文无效");
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encodedIv) },
      await encryptionKey(secret),
      base64ToBytes(encodedPayload),
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, string>;
  } catch {
    throw new Error("支付配置无法解密，请重新保存支付凭据");
  }
}

export async function resolveAlipayConfig(env: Env, paymentMethodId?: string | null): Promise<ResolvedAlipayConfig> {
  const environmentConfig = (): ResolvedAlipayConfig => {
    if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) throw new Error("站长尚未配置可用的支付方式");
    return {
      id: null,
      name: "支付宝",
      source: "environment",
      config: { appId: env.ALIPAY_APP_ID, privateKey: env.ALIPAY_PRIVATE_KEY, publicKey: env.ALIPAY_PUBLIC_KEY, gateway: env.ALIPAY_GATEWAY },
    };
  };
  if (paymentMethodId === null) return environmentConfig();
  const row = paymentMethodId
    ? await env.DB.prepare("SELECT id, display_name, enabled, config_json, secret_ciphertext FROM payment_methods WHERE id = ? AND provider = 'alipay'").bind(paymentMethodId).first<PaymentMethodRow>()
    : await env.DB.prepare("SELECT id, display_name, enabled, config_json, secret_ciphertext FROM payment_methods WHERE provider = 'alipay' LIMIT 1").first<PaymentMethodRow>();
  if (row) {
    if (!row.enabled && !paymentMethodId) throw new Error("支付宝支付方式未启用");
    const publicConfig = JSON.parse(row.config_json || "{}") as Record<string, string>;
    const secrets = await openPaymentSecrets(row.secret_ciphertext, env.SESSION_SECRET);
    if (!secrets.appId || !secrets.privateKey || !secrets.publicKey) throw new Error("支付宝支付配置不完整");
    return {
      id: row.id,
      name: row.display_name,
      source: "database",
      config: {
        appId: secrets.appId,
        privateKey: secrets.privateKey,
        publicKey: secrets.publicKey,
        gateway: publicConfig.gateway || "https://openapi.alipay.com/gateway.do",
      },
    };
  }
  if (paymentMethodId) throw new Error("订单使用的支付配置不存在");
  return environmentConfig();
}

function canonical(params: Record<string, string>, excludeSign = false): string {
  return Object.entries(params)
    .filter(([name, value]) => value !== "" && (!excludeSign || (name !== "sign" && name !== "sign_type")))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function sign(params: Record<string, string>, privateKey: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(canonical(params));
  signer.end();
  return signer.sign(key(privateKey), "base64");
}

export function verifyAlipayNotification(params: Record<string, string>, publicKey: string): boolean {
  if (!params.sign) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(canonical(params, true));
  verifier.end();
  return verifier.verify(key(publicKey), params.sign, "base64");
}

function timestamp(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace("T", " ");
}

async function request(config: AlipayConfig, appOrigin: string, notifyPath: string, method: string, bizContent: Record<string, unknown>) {
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: timestamp(),
    version: "1.0",
    notify_url: `${appOrigin.replace(/\/$/, "")}${notifyPath}`,
    biz_content: JSON.stringify(bizContent),
  };
  params.sign = sign(params, config.privateKey);
  const response = await fetch(config.gateway, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`支付宝网关不可用 (${response.status})`);
  const data = await response.json<Record<string, unknown>>();
  const responseKey = `${method.replaceAll(".", "_")}_response`;
  const payload = data[responseKey] as Record<string, unknown> | undefined;
  if (!payload || String(payload.code) !== "10000") throw new Error(String(payload?.sub_msg || payload?.msg || "支付宝请求失败"));
  return payload;
}

export async function createAlipayQr(resolved: ResolvedAlipayConfig, appOrigin: string, orderId: string, subject: string, cashCents: number, expiresAt: number) {
  const notifyPath = resolved.id ? `/api/payments/alipay/notify/${encodeURIComponent(resolved.id)}` : "/api/payments/alipay/notify";
  const payload = await request(resolved.config, appOrigin, notifyPath, "alipay.trade.precreate", {
    out_trade_no: orderId,
    total_amount: (cashCents / 100).toFixed(2),
    subject: subject.slice(0, 256),
    timeout_express: `${Math.max(1, Math.floor((expiresAt - Date.now() / 1000) / 60))}m`,
  });
  const qrContent = String(payload.qr_code || "");
  if (!qrContent) throw new Error("支付宝未返回支付二维码");
  return { qrContent, qrImage: await QRCode.toDataURL(qrContent, { width: 280, margin: 1 }) };
}

export async function queryAlipayOrder(resolved: ResolvedAlipayConfig, appOrigin: string, orderId: string) {
  const notifyPath = resolved.id ? `/api/payments/alipay/notify/${encodeURIComponent(resolved.id)}` : "/api/payments/alipay/notify";
  return request(resolved.config, appOrigin, notifyPath, "alipay.trade.query", { out_trade_no: orderId });
}
