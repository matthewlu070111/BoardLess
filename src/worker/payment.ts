import { createSign, createVerify } from "node:crypto";
import QRCode from "qrcode";
import type { Env } from "./types";

function key(value: string): string { return value.replaceAll("\\n", "\n").trim(); }

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

async function request(env: Env, method: string, bizContent: Record<string, unknown>) {
  const params: Record<string, string> = {
    app_id: env.ALIPAY_APP_ID,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: timestamp(),
    version: "1.0",
    notify_url: `${env.APP_ORIGIN.replace(/\/$/, "")}/api/payments/alipay/notify`,
    biz_content: JSON.stringify(bizContent),
  };
  params.sign = sign(params, env.ALIPAY_PRIVATE_KEY);
  const response = await fetch(env.ALIPAY_GATEWAY, {
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

export async function createAlipayQr(env: Env, orderId: string, subject: string, cashCents: number, expiresAt: number) {
  const payload = await request(env, "alipay.trade.precreate", {
    out_trade_no: orderId,
    total_amount: (cashCents / 100).toFixed(2),
    subject: subject.slice(0, 256),
    timeout_express: `${Math.max(1, Math.floor((expiresAt - Date.now() / 1000) / 60))}m`,
  });
  const qrContent = String(payload.qr_code || "");
  if (!qrContent) throw new Error("支付宝未返回支付二维码");
  return { qrContent, qrImage: await QRCode.toDataURL(qrContent, { width: 280, margin: 1 }) };
}

export async function queryAlipayOrder(env: Env, orderId: string) {
  return request(env, "alipay.trade.query", { out_trade_no: orderId });
}
