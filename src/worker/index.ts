import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { audit, earningsBalance, monthKey, newId, now, randomToken, sha256, walletBalance } from "./db";
import {
  authMiddleware, checkLoginRate, createSession, createUser, destroySession, loadUser, requireRole,
  signSubscriptionToken, verifyPassword, verifySubscriptionToken,
} from "./auth";
import { closeEntitlement, proratedCredit, settleExpiredEntitlements, settleNodePool } from "./finance";
import { createAlipayQr, openPaymentSecrets, queryAlipayOrder, resolveAlipayConfig, sealPaymentSecrets, verifyAlipayNotification } from "./payment";
import { renderSubscription, validateNodeConfig } from "./protocols";
import type { AppVariables, Env, NodeRow, PlanRow, Protocol, Role } from "./types";
import { importBackendRepository, renderPresetConfig, type BackendPreset, type ImportedBackend } from "./backends";

type App = { Bindings: Env; Variables: AppVariables };
export const app = new Hono<App>();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const protocols = new Set<Protocol>(["shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic"]);

app.use("/api/*", cors({ origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : c.env.APP_ORIGIN, credentials: true }));

function originAllowed(c: { req: { header(name: string): string | undefined }; env: Env }) {
  const origin = c.req.header("Origin");
  return !origin || origin === c.env.APP_ORIGIN || new URL(origin).host === new URL(c.env.APP_ORIGIN).host;
}

async function body<T>(c: { req: { json<T>(): Promise<T> } }): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new Error("请求内容不是有效 JSON"); }
}

function assertMutation(c: { req: { header(name: string): string | undefined }; env: Env }) {
  if (!originAllowed(c)) throw new Error("请求来源无效");
}

function publicUser(user: Awaited<ReturnType<typeof loadUser>>) {
  if (!user) return null;
  return { id: user.id, email: user.email, roles: user.roles, status: user.status, inviterAdminId: user.inviterAdminId };
}

app.onError((error, c) => {
  console.error(error);
  const message = error instanceof Error ? error.message : "服务器错误";
  const status = /不存在|无效|不能为空|必须|仅支持|不受支持|不足|过期|已被|缺少|不匹配|不一致|不能|超过|重复|只允许|占用|发生变化/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
});

app.get("/api/health", (c) => c.json({ ok: true, time: now() }));

app.post("/api/setup/bootstrap", async (c) => {
  assertMutation(c);
  const input = await body<{ secret: string; email: string; password: string }>(c);
  if (!input.secret || input.secret !== c.env.BOOTSTRAP_SECRET) return c.json({ error: "初始化密钥无效" }, 403);
  const exists = await c.env.DB.prepare("SELECT 1 FROM user_roles WHERE role = 'owner' LIMIT 1").first();
  if (exists) return c.json({ error: "站长账号已经初始化" }, 409);
  if (!emailPattern.test(input.email)) return c.json({ error: "邮箱格式不正确" }, 400);
  const id = await createUser(c.env, input.email, input.password, "owner", null);
  await audit(c.env, id, "owner.bootstrap", "user", id);
  return c.json({ ok: true, id }, 201);
});

app.post("/api/auth/login", async (c) => {
  assertMutation(c);
  const input = await body<{ email: string; password: string; portal?: "user" | "admin" }>(c);
  const email = String(input.email || "").trim().toLowerCase();
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  if (!(await checkLoginRate(c.env, await sha256(`${ip}:${email}`)))) return c.json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
  const row = await c.env.DB.prepare("SELECT id, password_hash, status FROM users WHERE email = ?").bind(email)
    .first<{ id: string; password_hash: string; status: string }>();
  if (!row || !(await verifyPassword(String(input.password || ""), row.password_hash))) return c.json({ error: "邮箱或密码错误" }, 401);
  const user = await loadUser(c.env, row.id);
  if (!user || user.status !== "active") return c.json({ error: "账号已停用" }, 403);
  if (input.portal === "admin" && !user.roles.some((role) => role === "admin" || role === "owner")) return c.json({ error: "该账号没有后台权限" }, 403);
  await createSession(c, user.id);
  await c.env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(await sha256(`${ip}:${email}`)).run();
  await audit(c.env, user.id, "auth.login", "session", null, { portal: input.portal || "user" });
  return c.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", async (c) => {
  assertMutation(c);
  await destroySession(c);
  return c.json({ ok: true });
});

app.get("/api/invitations/:token", async (c) => {
  const tokenHash = await sha256(c.req.param("token"));
  const invite = await c.env.DB.prepare(
    "SELECT i.role, i.expires_at, i.used_at, u.email AS inviter_email FROM invitations i JOIN users u ON u.id = i.inviter_id WHERE i.token_hash = ?",
  ).bind(tokenHash).first<Record<string, unknown>>();
  if (!invite || invite.used_at || Number(invite.expires_at) <= now()) return c.json({ error: "邀请链接无效或已过期" }, 404);
  return c.json({ role: invite.role, expiresAt: invite.expires_at, inviterEmail: invite.inviter_email });
});

app.post("/api/invitations/:token/accept", async (c) => {
  assertMutation(c);
  const input = await body<{ email: string; password: string }>(c);
  if (!emailPattern.test(input.email || "")) return c.json({ error: "邮箱格式不正确" }, 400);
  const tokenHash = await sha256(c.req.param("token"));
  const invite = await c.env.DB.prepare("SELECT id, role, inviter_id, expires_at, used_at FROM invitations WHERE token_hash = ?")
    .bind(tokenHash).first<{ id: string; role: Role; inviter_id: string; expires_at: number; used_at: number | null }>();
  if (!invite || invite.used_at || invite.expires_at <= now()) return c.json({ error: "邀请链接无效或已过期" }, 404);
  const inviter = await loadUser(c.env, invite.inviter_id);
  if (!inviter || inviter.status !== "active") return c.json({ error: "邀请人账号不可用" }, 400);
  const claimedAt = now();
  const claimed = await c.env.DB.prepare("UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(claimedAt, invite.id).run();
  if (!claimed.meta.changes) return c.json({ error: "邀请链接已被使用" }, 409);
  const inviterId = invite.role === "user" ? invite.inviter_id : null;
  let id: string;
  try { id = await createUser(c.env, input.email, input.password, invite.role, inviterId); }
  catch (error) {
    await c.env.DB.prepare("UPDATE invitations SET used_at = NULL WHERE id = ? AND used_at = ?").bind(invite.id, claimedAt).run();
    throw error;
  }
  await audit(c.env, id, "invitation.accept", "invitation", invite.id, { role: invite.role });
  await createSession(c, id);
  return c.json({ user: publicUser(await loadUser(c.env, id)) }, 201);
});

app.use("/api/me", authMiddleware);
app.get("/api/me", async (c) => c.json({ user: publicUser(c.get("user")) }));

app.use("/api/app/*", authMiddleware);
app.use("/api/admin/*", authMiddleware, requireRole("admin"));
app.use("/api/owner/*", authMiddleware, requireRole("owner"));

app.get("/api/app/dashboard", async (c) => {
  const user = c.get("user");
  const timestamp = now();
  const entitlement = await c.env.DB.prepare(
    `SELECT e.*, p.name AS plan_name FROM entitlements e JOIN plans p ON p.id = e.plan_id
     WHERE e.user_id = ? AND e.status = 'active' AND e.starts_at <= ? AND e.ends_at > ? ORDER BY e.ends_at DESC LIMIT 1`,
  ).bind(user.id, timestamp, timestamp).first<Record<string, unknown>>();
  const usage = await c.env.DB.prepare("SELECT up_bytes, down_bytes FROM quota_usage WHERE user_id = ? AND month_key = ?")
    .bind(user.id, monthKey()).first<{ up_bytes: number; down_bytes: number }>();
  const orderCount = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM orders WHERE user_id = ?")
    .bind(user.id).first<{ count: number }>();
  return c.json({ entitlement, usage: usage || { up_bytes: 0, down_bytes: 0 }, walletCents: await walletBalance(c.env, user.id), orderCount: orderCount?.count || 0 });
});

app.get("/api/app/plans", async (c) => {
  const plans = await c.env.DB.prepare(
    "SELECT p.*, COUNT(pn.node_id) AS node_count FROM plans p LEFT JOIN plan_nodes pn ON pn.plan_id = p.id WHERE p.status = 'active' GROUP BY p.id ORDER BY p.price_cents",
  ).all<PlanRow & { node_count: number }>();
  return c.json({ plans: plans.results });
});

app.get("/api/app/orders", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT o.*, p.name AS plan_name FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100",
  ).bind(c.get("user").id).all();
  return c.json({ orders: rows.results });
});

app.get("/api/app/usage", async (c) => {
  const rows = await c.env.DB.prepare("SELECT month_key, up_bytes, down_bytes FROM quota_usage WHERE user_id = ? ORDER BY month_key DESC LIMIT 12")
    .bind(c.get("user").id).all();
  return c.json({ usage: rows.results });
});

app.get("/api/app/subscription", async (c) => {
  const user = c.get("user");
  const active = await c.env.DB.prepare("SELECT 1 FROM entitlements WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND ends_at > ? LIMIT 1")
    .bind(user.id, now(), now()).first();
  const token = await signSubscriptionToken(c.env.SESSION_SECRET, user.id, user.subscriptionVersion);
  return c.json({ active: Boolean(active), baseUrl: `${c.env.APP_ORIGIN.replace(/\/$/, "")}/sub/${token}`, targets: ["clash", "singbox", "surge", "base64"] });
});

app.post("/api/app/subscription/rotate", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  await c.env.DB.prepare("UPDATE users SET subscription_version = subscription_version + 1 WHERE id = ?").bind(user.id).run();
  await audit(c.env, user.id, "subscription.rotate", "user", user.id);
  return c.json({ ok: true });
});

interface OrderRecord {
  id: string; user_id: string; plan_id: string; status: string; price_cents: number; wallet_cents: number; cash_cents: number;
  upgrade_credit_cents: number; upgrade_from_entitlement_id: string | null; expires_at: number; entitlement_id: string | null;
  duration_days: number; quota_bytes: number; node_pool_bps: number;
  payment_method_id: string | null; payment_provider: string | null;
}

interface EntitlementRecord {
  id: string; user_id: string; plan_id: string; order_id: string; starts_at: number; ends_at: number; original_seconds: number;
  price_cents: number; quota_bytes: number; node_pool_bps: number; status: "active" | "closed" | "expired";
}

async function activateOrder(env: Env, orderId: string, tradeNo: string | null) {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRecord>();
  if (!order) throw new Error("订单不存在");
  if (order.status === "paid") return order.entitlement_id;
  if (order.status !== "pending" || order.expires_at <= now()) throw new Error("订单已失效");
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(order.plan_id).first<PlanRow>();
  if (!plan) throw new Error("套餐不存在");
  const current = await env.DB.prepare(
    "SELECT * FROM entitlements WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1",
  ).bind(order.user_id, now(), now()).first<EntitlementRecord>();
  if (order.upgrade_from_entitlement_id && current?.id !== order.upgrade_from_entitlement_id) {
    await env.DB.prepare("UPDATE orders SET status = 'review' WHERE id = ?").bind(order.id).run();
    throw new Error("当前套餐已变化，订单需要站长复核");
  }

  const timestamp = now();
  const entitlementId = newId("ent");
  const renewing = current && current.plan_id === plan.id && !order.upgrade_from_entitlement_id;
  const latestRenewal = renewing ? await env.DB.prepare("SELECT MAX(ends_at) AS ends_at FROM entitlements WHERE user_id = ? AND plan_id = ? AND status = 'active'")
    .bind(order.user_id, plan.id).first<{ ends_at: number }>() : null;
  const startsAt = renewing ? Math.max(current.ends_at, Number(latestRenewal?.ends_at || 0)) : timestamp;
  const endsAt = startsAt + order.duration_days * 86400;
  const statements: D1PreparedStatement[] = [];

  if (current && order.upgrade_from_entitlement_id) {
    statements.push(env.DB.prepare("UPDATE entitlements SET status = 'closed', closed_at = ?, close_reason = 'upgrade' WHERE id = ? AND status = 'active'").bind(timestamp, current.id));
    if (order.upgrade_credit_cents > 0) statements.push(env.DB.prepare(
      "INSERT INTO wallet_ledger (id, user_id, order_id, kind, amount_cents, created_at) VALUES (?, ?, ?, 'upgrade_credit', ?, ?)",
    ).bind(newId("wallet"), order.user_id, order.id, order.upgrade_credit_cents, timestamp));
    const commission = await env.DB.prepare("SELECT admin_id, amount_cents FROM earnings_ledger WHERE entitlement_id = ? AND kind = 'sales_commission'")
      .bind(current.id).first<{ admin_id: string; amount_cents: number }>();
    if (commission && order.upgrade_credit_cents > 0) statements.push(env.DB.prepare(
      "INSERT INTO earnings_ledger (id, admin_id, order_id, entitlement_id, kind, amount_cents, available_at, metadata_json, created_at) VALUES (?, ?, ?, ?, 'upgrade_reversal', ?, ?, ?, ?)",
    ).bind(newId("earn"), commission.admin_id, current.order_id, current.id,
      -Math.floor(commission.amount_cents * order.upgrade_credit_cents / Math.max(1, current.price_cents)), timestamp,
      JSON.stringify({ credit_cents: order.upgrade_credit_cents }), timestamp));
  }

  if (order.wallet_cents > 0) statements.push(env.DB.prepare(
    "INSERT INTO wallet_ledger (id, user_id, order_id, kind, amount_cents, created_at) VALUES (?, ?, ?, 'purchase', ?, ?)",
  ).bind(newId("wallet"), order.user_id, order.id, -order.wallet_cents, timestamp));

  statements.push(env.DB.prepare(
    `INSERT INTO entitlements (id, user_id, plan_id, order_id, starts_at, ends_at, original_seconds, price_cents, quota_bytes, node_pool_bps, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  ).bind(entitlementId, order.user_id, plan.id, order.id, startsAt, endsAt, order.duration_days * 86400, order.price_cents, order.quota_bytes, order.node_pool_bps));
  statements.push(env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, alipay_trade_no = CASE WHEN payment_provider IS NULL OR payment_provider = 'alipay' THEN COALESCE(?, alipay_trade_no) ELSE alipay_trade_no END, external_trade_no = COALESCE(?, external_trade_no), entitlement_id = ? WHERE id = ? AND status = 'pending'")
    .bind(timestamp, tradeNo, tradeNo, entitlementId, order.id));

  const user = await env.DB.prepare("SELECT inviter_admin_id FROM users WHERE id = ?").bind(order.user_id).first<{ inviter_admin_id: string | null }>();
  if (user?.inviter_admin_id && order.cash_cents > 0) {
    const profile = await env.DB.prepare("SELECT commission_bps FROM admin_profiles WHERE user_id = ? AND disabled_at IS NULL")
      .bind(user.inviter_admin_id).first<{ commission_bps: number }>();
    const commission = Math.floor(order.cash_cents * Number(profile?.commission_bps || 0) / 10000);
    if (commission > 0) statements.push(env.DB.prepare(
      "INSERT INTO earnings_ledger (id, admin_id, order_id, entitlement_id, kind, amount_cents, available_at, metadata_json, created_at) VALUES (?, ?, ?, ?, 'sales_commission', ?, ?, ?, ?)",
    ).bind(newId("earn"), user.inviter_admin_id, order.id, entitlementId, commission, timestamp + 7 * 86400, JSON.stringify({ rate_bps: profile?.commission_bps }), timestamp));
  }

  await env.DB.batch(statements);
  if (current && order.upgrade_from_entitlement_id) await settleNodePool(env, current, timestamp, "upgrade");
  await audit(env, order.user_id, "order.paid", "order", order.id, { entitlementId, tradeNo });
  return entitlementId;
}

app.post("/api/app/orders", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const input = await body<{ planId: string }>(c);
  const plan = await c.env.DB.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").bind(input.planId).first<PlanRow>();
  if (!plan) return c.json({ error: "套餐不存在" }, 404);
  if (user.inviterAdminId) {
    const profile = await c.env.DB.prepare("SELECT commission_bps FROM admin_profiles WHERE user_id = ? AND disabled_at IS NULL")
      .bind(user.inviterAdminId).first<{ commission_bps: number }>();
    if (Number(profile?.commission_bps || 0) + Number(plan.node_pool_bps) > 10000) return c.json({ error: "套餐分账比例配置无效，请联系站长" }, 400);
  }
  const timestamp = now();
  const active = await c.env.DB.prepare(
    "SELECT * FROM entitlements WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1",
  ).bind(user.id, timestamp, timestamp).first<EntitlementRecord>();
  const queued = await c.env.DB.prepare("SELECT 1 FROM entitlements WHERE user_id = ? AND status = 'active' AND starts_at > ? LIMIT 1")
    .bind(user.id, timestamp).first();
  if (queued) return c.json({ error: "已有待生效续费，请生效后再购买或联系站长处理" }, 409);
  const upgrade = active && active.plan_id !== plan.id ? active : null;
  const upgradeCredit = upgrade ? proratedCredit(upgrade.price_cents, upgrade.starts_at, upgrade.ends_at, timestamp) : 0;
  const balance = await walletBalance(c.env, user.id);
  const walletCents = Math.min(plan.price_cents, balance + upgradeCredit);
  const cashCents = plan.price_cents - walletCents;
  const orderId = newId("ord");
  const expiresAt = timestamp + 15 * 60;
  const paymentMethod = cashCents > 0 ? await resolveAlipayConfig(c.env) : null;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").bind(user.id),
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, plan_id, status, price_cents, wallet_cents, cash_cents, upgrade_credit_cents, upgrade_from_entitlement_id, expires_at, created_at, duration_days, quota_bytes, node_pool_bps, payment_method_id, payment_provider)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(orderId, user.id, plan.id, plan.price_cents, walletCents, cashCents, upgradeCredit, upgrade?.id || null, expiresAt, timestamp, plan.duration_days, plan.quota_bytes, plan.node_pool_bps, paymentMethod?.id || null, paymentMethod ? "alipay" : null),
  ]);
  if (cashCents === 0) {
    await activateOrder(c.env, orderId, null);
    return c.json({ orderId, status: "paid", cashCents: 0, walletCents, upgradeCredit }, 201);
  }
  try {
    const qr = await createAlipayQr(paymentMethod!, c.env.APP_ORIGIN, orderId, `BoardLess - ${plan.name}`, cashCents, expiresAt);
    await c.env.DB.prepare("UPDATE orders SET qr_code = ? WHERE id = ?").bind(qr.qrContent, orderId).run();
    return c.json({ orderId, status: "pending", cashCents, walletCents, upgradeCredit, expiresAt, qrImage: qr.qrImage, paymentProvider: "alipay", paymentName: paymentMethod!.name }, 201);
  } catch (error) {
    await c.env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(orderId).run();
    throw error;
  }
});

app.get("/api/app/orders/:id", async (c) => {
  const user = c.get("user");
  let order = await c.env.DB.prepare("SELECT o.*, p.name AS plan_name FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.id = ? AND o.user_id = ?")
    .bind(c.req.param("id"), user.id).first<Record<string, unknown>>();
  if (!order) return c.json({ error: "订单不存在" }, 404);
  if (order.status === "pending" && Number(order.expires_at) <= now()) {
    await c.env.DB.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(order.id).run();
    order = { ...order, status: "expired" };
  }
  return c.json({ order });
});

app.post("/api/app/orders/:id/query", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<OrderRecord>();
  if (!order) return c.json({ error: "订单不存在" }, 404);
  if (order.status !== "pending") return c.json({ status: order.status });
  if (order.payment_provider && order.payment_provider !== "alipay") return c.json({ error: "该支付方式暂不支持主动查询" }, 400);
  const paymentMethod = await resolveAlipayConfig(c.env, order.payment_method_id);
  const result = await queryAlipayOrder(paymentMethod, c.env.APP_ORIGIN, order.id);
  if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(String(result.trade_status))) await activateOrder(c.env, order.id, String(result.trade_no || ""));
  return c.json({ status: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(String(result.trade_status)) ? "paid" : "pending" });
});

async function handleAlipayNotification(c: Context<App>, paymentMethodId?: string) {
  const form = await c.req.parseBody();
  const params = Object.fromEntries(Object.entries(form).map(([name, value]) => [name, String(value)]));
  let paymentMethod;
  try { paymentMethod = await resolveAlipayConfig(c.env, paymentMethodId || null); }
  catch { return c.text("failure", 400); }
  if (!verifyAlipayNotification(params, paymentMethod.config.publicKey) || params.app_id !== paymentMethod.config.appId) return c.text("failure", 400);
  if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(params.trade_status)) return c.text("success");
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(params.out_trade_no).first<OrderRecord>();
  if (!order || (paymentMethod.id && order.payment_method_id !== paymentMethod.id) || Math.round(Number(params.total_amount) * 100) !== order.cash_cents) return c.text("failure", 400);
  const eventKey = `alipay:${paymentMethod.id || "env"}:${params.notify_id || `${params.trade_no}:${params.trade_status}`}`;
  const seen = await c.env.DB.prepare("SELECT 1 FROM payment_events WHERE event_key = ?").bind(eventKey).first();
  if (seen) return c.text("success");
  await activateOrder(c.env, order.id, params.trade_no);
  await c.env.DB.prepare("INSERT INTO payment_events (event_key, order_id, payload_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(eventKey, order.id, await sha256(JSON.stringify(params)), now()).run();
  return c.text("success");
}

app.post("/api/payments/alipay/notify", (c) => handleAlipayNotification(c));
app.post("/api/payments/alipay/notify/:methodId", (c) => handleAlipayNotification(c, c.req.param("methodId")));

async function ensureActiveAdmin(env: Env, userId: string) {
  const profile = await env.DB.prepare("SELECT disabled_at FROM admin_profiles WHERE user_id = ?").bind(userId).first<{ disabled_at: number | null }>();
  if (!profile || profile.disabled_at) throw new Error("管理员账号已停用");
}

async function createInvitation(env: Env, inviterId: string, role: "user" | "admin", expiresHours: number) {
  const token = randomToken(32);
  const id = newId("inv");
  await env.DB.prepare("INSERT INTO invitations (id, token_hash, role, inviter_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256(token), role, inviterId, now() + Math.min(168, Math.max(1, expiresHours)) * 3600, now()).run();
  return { id, token, expiresAt: now() + Math.min(168, Math.max(1, expiresHours)) * 3600 };
}

async function saveImportedBackend(env: Env, actorId: string, imported: ImportedBackend) {
  const byBackend = await env.DB.prepare("SELECT id, repository_url FROM backend_repositories WHERE backend_id = ?")
    .bind(imported.manifest.backendId).first<{ id: string; repository_url: string }>();
  const byRepository = await env.DB.prepare("SELECT id, backend_id FROM backend_repositories WHERE repository_url = ?")
    .bind(imported.repositoryUrl).first<{ id: string; backend_id: string }>();
  if (byBackend && byBackend.repository_url !== imported.repositoryUrl) throw new Error("该 backendId 已被另一仓库占用，仓库转移必须人工处理");
  if (byRepository && byRepository.backend_id !== imported.manifest.backendId) throw new Error("该仓库声明的 backendId 已发生变化，不能静默覆盖");
  const id = byBackend?.id || byRepository?.id || newId("backend");
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO backend_repositories
       (id, backend_id, repository_url, repository_owner, repository_name, requested_ref, commit_sha, readme_path, readme_url, readme_hash,
        name, version, panel_api_version, install_script, install_script_url, install_sha256, manifest_json, status, imported_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET requested_ref = excluded.requested_ref, commit_sha = excluded.commit_sha,
       readme_path = excluded.readme_path, readme_url = excluded.readme_url, readme_hash = excluded.readme_hash,
       name = excluded.name, version = excluded.version, panel_api_version = excluded.panel_api_version,
       install_script = excluded.install_script, install_script_url = excluded.install_script_url,
       install_sha256 = excluded.install_sha256, manifest_json = excluded.manifest_json,
       status = 'pending', imported_by = excluded.imported_by, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
    ).bind(
      id, imported.manifest.backendId, imported.repositoryUrl, imported.owner, imported.repository, imported.requestedRef,
      imported.commitSha, imported.readmePath, imported.readmeUrl, imported.readmeHash, imported.manifest.name,
      imported.manifest.version, imported.manifest.panelApiVersion, imported.manifest.install.script,
      imported.installScriptUrl, imported.manifest.install.sha256, JSON.stringify(imported.manifest), actorId,
      timestamp, timestamp, timestamp,
    ),
    env.DB.prepare("DELETE FROM backend_presets WHERE backend_repository_id = ?").bind(id),
    ...imported.manifest.presets.map((preset) => env.DB.prepare(
      `INSERT INTO backend_presets
       (backend_repository_id, preset_id, name, protocol, description, config_json, required_inputs_json, generated_outputs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, preset.id, preset.name, preset.protocol, preset.description, JSON.stringify(preset.config), JSON.stringify(preset.requiredInputs), JSON.stringify(preset.generatedOutputs))),
  ];
  await env.DB.batch(statements);
  await audit(env, actorId, byBackend || byRepository ? "backend.sync.preview" : "backend.import.preview", "backend_repository", id, {
    backendId: imported.manifest.backendId, repositoryUrl: imported.repositoryUrl, commitSha: imported.commitSha,
  });
  return { id, status: "pending" as const };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

app.get("/api/owner/backends", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.*, COUNT(p.preset_id) AS preset_count
     FROM backend_repositories b LEFT JOIN backend_presets p ON p.backend_repository_id = b.id
     GROUP BY b.id ORDER BY b.updated_at DESC`,
  ).all<Record<string, unknown>>();
  return c.json({ backends: rows.results.map((row) => ({ ...row, manifest_json: undefined })) });
});

app.post("/api/owner/backends/import", async (c) => {
  assertMutation(c);
  const input = await body<{ repositoryUrl: string; ref?: string; readmePath?: string }>(c);
  const imported = await importBackendRepository(String(input.repositoryUrl || ""), String(input.ref || ""), String(input.readmePath || "README.md"));
  const saved = await saveImportedBackend(c.env, c.get("user").id, imported);
  return c.json({
    backend: { ...saved, backendId: imported.manifest.backendId, name: imported.manifest.name, version: imported.manifest.version },
    preview: {
      repositoryUrl: imported.repositoryUrl, requestedRef: imported.requestedRef, commitSha: imported.commitSha,
      readmeHash: imported.readmeHash, installScript: imported.manifest.install.script,
      installSha256: imported.manifest.install.sha256,
      presets: imported.manifest.presets.map(({ id, name, protocol, description, requiredInputs, generatedOutputs }) => ({ id, name, protocol, description, requiredInputs, generatedOutputs })),
    },
  }, 201);
});

app.post("/api/owner/backends/:id/confirm", async (c) => {
  assertMutation(c);
  const result = await c.env.DB.prepare("UPDATE backend_repositories SET status = 'enabled', updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(now(), c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "后端不存在或无需确认" }, 404);
  await audit(c.env, c.get("user").id, "backend.confirm", "backend_repository", c.req.param("id"));
  return c.json({ ok: true, status: "enabled" });
});

app.post("/api/owner/backends/:id/sync", async (c) => {
  assertMutation(c);
  const input = await body<{ ref?: string }>(c);
  const current = await c.env.DB.prepare("SELECT repository_url, requested_ref, readme_path, commit_sha FROM backend_repositories WHERE id = ?")
    .bind(c.req.param("id")).first<{ repository_url: string; requested_ref: string; readme_path: string; commit_sha: string }>();
  if (!current) return c.json({ error: "后端仓库不存在" }, 404);
  const imported = await importBackendRepository(current.repository_url, input.ref?.trim() || current.requested_ref, current.readme_path);
  const saved = await saveImportedBackend(c.env, c.get("user").id, imported);
  return c.json({ backend: saved, diff: { previousCommitSha: current.commit_sha, commitSha: imported.commitSha, changed: current.commit_sha !== imported.commitSha }, status: "pending" });
});

app.patch("/api/owner/backends/:id", async (c) => {
  assertMutation(c);
  const input = await body<{ enabled: boolean }>(c);
  if (typeof input.enabled !== "boolean") return c.json({ error: "enabled 必须是布尔值" }, 400);
  const status = input.enabled ? "enabled" : "disabled";
  const result = await c.env.DB.prepare("UPDATE backend_repositories SET status = ?, updated_at = ? WHERE id = ? AND status != 'pending'")
    .bind(status, now(), c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "后端不存在或仍在等待确认" }, 404);
  await audit(c.env, c.get("user").id, `backend.${status}`, "backend_repository", c.req.param("id"));
  return c.json({ ok: true, status });
});

app.get("/api/admin/node-presets", async (c) => {
  await ensureActiveAdmin(c.env, c.get("user").id);
  const rows = await c.env.DB.prepare(
    `SELECT p.*, b.backend_id, b.name AS backend_name, b.version AS backend_version, b.commit_sha
     FROM backend_presets p JOIN backend_repositories b ON b.id = p.backend_repository_id
     WHERE b.status = 'enabled' ORDER BY b.name, p.name`,
  ).all<Record<string, unknown>>();
  return c.json({ presets: rows.results.map((row) => ({
    ...row,
    config: JSON.parse(String(row.config_json)),
    requiredInputs: parseStringArray(String(row.required_inputs_json)),
    generatedOutputs: parseStringArray(String(row.generated_outputs_json)),
    config_json: undefined, required_inputs_json: undefined, generated_outputs_json: undefined,
  })) });
});

app.post("/api/admin/nodes/from-preset", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  await ensureActiveAdmin(c.env, user.id);
  const input = await body<{ backendId: string; presetId: string; name: string; inputs: Record<string, unknown> }>(c);
  if (!input.name?.trim() || input.name.length > 80) return c.json({ error: "节点名称不能为空且最多 80 字" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT p.*, b.id AS backend_repository_id, b.backend_id
     FROM backend_presets p JOIN backend_repositories b ON b.id = p.backend_repository_id
     WHERE b.backend_id = ? AND p.preset_id = ? AND b.status = 'enabled'`,
  ).bind(String(input.backendId || ""), String(input.presetId || "")).first<Record<string, unknown>>();
  if (!row) return c.json({ error: "后端预设不存在或尚未启用" }, 404);
  const requiredInputs = parseStringArray(String(row.required_inputs_json));
  const values: Record<string, string> = {};
  if (!input.inputs || typeof input.inputs !== "object" || Array.isArray(input.inputs)) return c.json({ error: "inputs 必须是对象" }, 400);
  for (const key of requiredInputs) {
    const value = input.inputs[key];
    if (typeof value !== "string" || !value.trim() || value.length > 512) return c.json({ error: `缺少或无效的预设输入：${key}` }, 400);
    values[key] = value.trim();
  }
  if (Object.keys(input.inputs).some((key) => !requiredInputs.includes(key))) return c.json({ error: "inputs 包含预设未声明的字段" }, 400);
  const generatedOutputs = parseStringArray(String(row.generated_outputs_json));
  const template = JSON.parse(String(row.config_json)) as Record<string, unknown>;
  const rendered = renderPresetConfig(template, values) as Record<string, unknown>;
  const config = generatedOutputs.length ? rendered : validateNodeConfig(row.protocol as Protocol, rendered);
  const id = newId("node");
  await c.env.DB.prepare(
    `INSERT INTO nodes
     (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at, backend_repository_id, backend_preset_id)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user.id, input.name.trim(), row.protocol, JSON.stringify(config), await sha256(randomToken(32)), now(), now(), row.backend_repository_id, row.preset_id).run();
  await audit(c.env, user.id, "node.create.from_preset", "node", id, { backendId: row.backend_id, presetId: row.preset_id });
  return c.json({ node: { id, name: input.name.trim(), protocol: row.protocol, status: "pending", config }, generatedOutputs }, 201);
});

app.post("/api/admin/nodes/:id/install-command", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  await ensureActiveAdmin(c.env, user.id);
  const row = await c.env.DB.prepare(
    `SELECT n.id, n.backend_preset_id, b.id AS backend_repository_id, b.install_script_url, b.install_sha256, b.version, b.status
     FROM nodes n JOIN backend_repositories b ON b.id = n.backend_repository_id
     WHERE n.id = ? AND n.owner_admin_id = ? AND n.status = 'pending'`,
  ).bind(c.req.param("id"), user.id).first<Record<string, unknown>>();
  if (!row || row.status !== "enabled") return c.json({ error: "节点不存在、状态无效或后端未启用" }, 404);
  const token = randomToken(32);
  const expiresAt = now() + 300;
  await c.env.DB.prepare(
    `INSERT INTO node_install_tokens
     (id, token_hash, node_id, backend_repository_id, preset_id, inputs_json, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).bind(newId("install"), await sha256(token), row.id, row.backend_repository_id, row.backend_preset_id, expiresAt, user.id, now()).run();
  const file = "/tmp/boardless-node-install.sh";
  const command = [
    `curl -fsSL ${shellQuote(String(row.install_script_url))} -o ${shellQuote(file)}`,
    `echo ${shellQuote(`${row.install_sha256}  ${file}`)} | sha256sum -c -`,
    `sudo bash ${shellQuote(file)} --panel-url ${shellQuote(c.env.APP_ORIGIN.replace(/\/$/, ""))} --install-token ${shellQuote(token)} --preset ${shellQuote(String(row.backend_preset_id))} --agent-version ${shellQuote(String(row.version))} --unattended`,
  ].join(" && \\\n  ");
  await audit(c.env, user.id, "node.install_command.create", "node", String(row.id), { expiresAt });
  return c.json({ command, expiresAt, sha256: row.install_sha256, scriptUrl: row.install_script_url });
});

app.post("/api/node/v1/bootstrap", async (c) => {
  const input = await body<{ installToken: string; generatedOutputs?: Record<string, unknown>; agentVersion?: string }>(c);
  const installToken = String(input.installToken || "");
  if (!installToken) return c.json({ error: "安装令牌不能为空" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT t.id AS install_id, t.node_id, t.expires_at, t.used_at, n.config_json AS node_config_json, p.generated_outputs_json, n.status
     FROM node_install_tokens t
     JOIN backend_presets p ON p.backend_repository_id = t.backend_repository_id AND p.preset_id = t.preset_id
     JOIN backend_repositories b ON b.id = t.backend_repository_id
     JOIN nodes n ON n.id = t.node_id
     WHERE t.token_hash = ? AND b.status = 'enabled'`,
  ).bind(await sha256(installToken)).first<Record<string, unknown>>();
  if (!row || row.used_at || Number(row.expires_at) <= now() || row.status !== "pending") return c.json({ error: "安装令牌无效、已使用或已过期" }, 401);
  const allowed = parseStringArray(String(row.generated_outputs_json));
  const supplied = input.generatedOutputs || {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).some((key) => !allowed.includes(key))) {
    return c.json({ error: "generatedOutputs 包含未声明字段" }, 400);
  }
  const generated: Record<string, string> = {};
  for (const key of allowed) {
    const value = supplied[key];
    if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 512 || String(value).length === 0) {
      return c.json({ error: `缺少或无效的生成字段：${key}` }, 400);
    }
    generated[key] = String(value);
  }
  const template = JSON.parse(String(row.node_config_json)) as Record<string, unknown>;
  const rendered = renderPresetConfig(template, {}, generated);
  const node = await c.env.DB.prepare("SELECT protocol FROM nodes WHERE id = ?").bind(row.node_id).first<{ protocol: Protocol }>();
  if (!node) return c.json({ error: "节点不存在" }, 404);
  const config = validateNodeConfig(node.protocol, rendered);
  const claimed = await c.env.DB.prepare("UPDATE node_install_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now(), row.install_id, now()).run();
  if (!claimed.meta.changes) return c.json({ error: "安装令牌已被使用" }, 409);
  const nodeToken = randomToken(32);
  await c.env.DB.prepare("UPDATE nodes SET config_json = ?, token_hash = ?, agent_version = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(JSON.stringify(config), await sha256(nodeToken), String(input.agentVersion || "").slice(0, 80), now(), row.node_id).run();
  await audit(c.env, null, "node.bootstrap", "node", String(row.node_id));
  return c.json({ nodeId: row.node_id, nodeToken, status: "pending", config });
});

app.get("/api/admin/overview", async (c) => {
  const user = c.get("user");
  await ensureActiveAdmin(c.env, user.id);
  const [nodes, invited, withdrawals] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE owner_admin_id = ? AND status != 'archived'").bind(user.id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE inviter_admin_id = ?").bind(user.id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM withdrawals WHERE admin_id = ? AND status = 'pending'").bind(user.id).first<{ count: number }>(),
  ]);
  return c.json({ nodeCount: nodes?.count || 0, invitedUsers: invited?.count || 0, availableCents: await earningsBalance(c.env, user.id), pendingWithdrawals: withdrawals?.count || 0 });
});

app.get("/api/admin/nodes", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, name, protocol, status, config_json, last_seen_at, online_count, agent_version, created_at, updated_at FROM nodes WHERE owner_admin_id = ? ORDER BY created_at DESC")
    .bind(c.get("user").id).all();
  return c.json({ nodes: rows.results.map((row) => ({ ...row, config: JSON.parse(String(row.config_json)), config_json: undefined })) });
});

app.post("/api/admin/nodes", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  await ensureActiveAdmin(c.env, user.id);
  const input = await body<{ name: string; protocol: Protocol; config: unknown }>(c);
  if (!input.name?.trim() || input.name.length > 80) return c.json({ error: "节点名称不能为空且最多 80 字" }, 400);
  if (!protocols.has(input.protocol)) return c.json({ error: "节点协议不受支持" }, 400);
  const config = validateNodeConfig(input.protocol, input.config);
  const token = randomToken(32);
  const id = newId("node");
  await c.env.DB.prepare(
    "INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
  ).bind(id, user.id, input.name.trim(), input.protocol, JSON.stringify(config), await sha256(token), now(), now()).run();
  await audit(c.env, user.id, "node.create", "node", id, { protocol: input.protocol });
  return c.json({ node: { id, name: input.name.trim(), protocol: input.protocol, status: "pending", config }, token }, 201);
});

app.patch("/api/admin/nodes/:id", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const current = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ? AND owner_admin_id = ?").bind(c.req.param("id"), user.id).first<NodeRow>();
  if (!current) return c.json({ error: "节点不存在" }, 404);
  if (current.status === "archived") return c.json({ error: "归档节点不可编辑" }, 400);
  const input = await body<{ name?: string; config?: unknown; archive?: boolean }>(c);
  if (input.archive) {
    await c.env.DB.prepare("UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?").bind(now(), current.id).run();
    await audit(c.env, user.id, "node.archive", "node", current.id);
    return c.json({ ok: true });
  }
  const name = input.name?.trim() || current.name;
  const config = input.config ? validateNodeConfig(current.protocol, input.config) : JSON.parse(current.config_json);
  await c.env.DB.prepare("UPDATE nodes SET name = ?, config_json = ?, status = 'pending', updated_at = ? WHERE id = ?")
    .bind(name, JSON.stringify(config), now(), current.id).run();
  await audit(c.env, user.id, "node.update", "node", current.id);
  return c.json({ ok: true, status: "pending" });
});

app.post("/api/admin/nodes/:id/rotate-token", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const node = await c.env.DB.prepare("SELECT id FROM nodes WHERE id = ? AND owner_admin_id = ?").bind(c.req.param("id"), user.id).first();
  if (!node) return c.json({ error: "节点不存在" }, 404);
  const token = randomToken(32);
  await c.env.DB.prepare("UPDATE nodes SET token_hash = ?, updated_at = ? WHERE id = ?").bind(await sha256(token), now(), c.req.param("id")).run();
  await audit(c.env, user.id, "node.token.rotate", "node", c.req.param("id"));
  return c.json({ token });
});

app.get("/api/admin/invitations", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, role, expires_at, used_at, created_at FROM invitations WHERE inviter_id = ? ORDER BY created_at DESC LIMIT 100")
    .bind(c.get("user").id).all();
  return c.json({ invitations: rows.results });
});

app.post("/api/admin/invitations", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  await ensureActiveAdmin(c.env, user.id);
  const input = await body<{ expiresHours?: number }>(c);
  const invite = await createInvitation(c.env, user.id, "user", Number(input.expiresHours || 72));
  await audit(c.env, user.id, "invitation.create", "invitation", invite.id, { role: "user" });
  return c.json({ ...invite, url: `${c.env.APP_ORIGIN.replace(/\/$/, "")}/invite/${invite.token}` }, 201);
});

app.get("/api/admin/users", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.created_at,
      (SELECT MAX(ends_at) FROM entitlements e WHERE e.user_id = u.id AND e.status = 'active') AS expires_at
     FROM users u WHERE u.inviter_admin_id = ? ORDER BY u.created_at DESC`,
  ).bind(c.get("user").id).all();
  return c.json({ users: rows.results });
});

app.patch("/api/admin/users/:id", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND inviter_admin_id = ?").bind(c.req.param("id"), user.id).first();
  if (!target) return c.json({ error: "用户不存在" }, 404);
  const input = await body<{ status: "active" | "disabled" }>(c);
  if (!["active", "disabled"].includes(input.status)) return c.json({ error: "状态无效" }, 400);
  await c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(input.status, c.req.param("id")).run();
  await audit(c.env, user.id, "user.status", "user", c.req.param("id"), { status: input.status });
  return c.json({ ok: true });
});

app.get("/api/admin/earnings", async (c) => {
  const user = c.get("user");
  const rows = await c.env.DB.prepare("SELECT * FROM earnings_ledger WHERE admin_id = ? ORDER BY created_at DESC LIMIT 200").bind(user.id).all();
  return c.json({ entries: rows.results, availableCents: await earningsBalance(c.env, user.id) });
});

app.get("/api/admin/withdrawals", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM withdrawals WHERE admin_id = ? ORDER BY created_at DESC").bind(c.get("user").id).all();
  return c.json({ withdrawals: rows.results });
});

app.post("/api/admin/withdrawals", async (c) => {
  assertMutation(c);
  const user = c.get("user");
  const input = await body<{ amountCents: number; alipayAccount: string }>(c);
  const amount = Math.floor(Number(input.amountCents));
  if (amount < 10000) return c.json({ error: "最低提现金额为 ¥100" }, 400);
  if (!input.alipayAccount?.trim()) return c.json({ error: "支付宝账号不能为空" }, 400);
  const id = newId("wd");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO withdrawals (id, admin_id, amount_cents, alipay_account, status, created_at)
       SELECT ?, ?, ?, ?, 'pending', ?
       WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings_ledger WHERE admin_id = ? AND available_at <= ?) >= ?`,
    ).bind(id, user.id, amount, input.alipayAccount.trim(), now(), user.id, now(), amount),
    c.env.DB.prepare(
      `INSERT INTO earnings_ledger (id, admin_id, kind, amount_cents, available_at, metadata_json, created_at)
       SELECT ?, ?, 'withdrawal_hold', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM withdrawals WHERE id = ?)`,
    ).bind(newId("earn"), user.id, -amount, now(), JSON.stringify({ withdrawal_id: id }), now(), id),
    c.env.DB.prepare("UPDATE admin_profiles SET alipay_account = ? WHERE user_id = ?").bind(input.alipayAccount.trim(), user.id),
  ]);
  const created = await c.env.DB.prepare("SELECT 1 FROM withdrawals WHERE id = ?").bind(id).first();
  if (!created) return c.json({ error: "可提现余额不足" }, 400);
  await audit(c.env, user.id, "withdrawal.create", "withdrawal", id, { amount });
  return c.json({ id, status: "pending" }, 201);
});

app.get("/api/owner/overview", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM admin_profiles WHERE disabled_at IS NULL) AS admins,
      (SELECT COUNT(*) FROM nodes WHERE status = 'approved') AS active_nodes,
      (SELECT COUNT(*) FROM nodes WHERE status = 'pending') AS pending_nodes,
      (SELECT COALESCE(SUM(cash_cents), 0) FROM orders WHERE status = 'paid') AS revenue_cents,
      (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_withdrawals`,
  ).first();
  return c.json({ overview: result });
});

app.get("/api/owner/nodes", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT n.*, u.email AS owner_email FROM nodes n JOIN users u ON u.id = n.owner_admin_id ORDER BY
      CASE n.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, n.created_at DESC`,
  ).all<NodeRow>();
  return c.json({ nodes: rows.results.map((row) => ({ ...row, config: JSON.parse(row.config_json), config_json: undefined, token_hash: undefined })) });
});

app.post("/api/owner/nodes", async (c) => {
  assertMutation(c);
  const owner = c.get("user");
  const input = await body<{ name: string; protocol: Protocol; config: unknown }>(c);
  if (!input.name?.trim() || input.name.length > 80) return c.json({ error: "节点名称不能为空且最多 80 字" }, 400);
  if (!protocols.has(input.protocol)) return c.json({ error: "节点协议不受支持" }, 400);
  const config = validateNodeConfig(input.protocol, input.config);
  const token = randomToken(32);
  const id = newId("node");
  await c.env.DB.prepare(
    "INSERT INTO nodes (id, owner_admin_id, name, protocol, status, config_json, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)",
  ).bind(id, owner.id, input.name.trim(), input.protocol, JSON.stringify(config), await sha256(token), now(), now()).run();
  await audit(c.env, owner.id, "node.create", "node", id, { protocol: input.protocol, source: "owner" });
  return c.json({ node: { id, name: input.name.trim(), protocol: input.protocol, status: "approved", config }, token }, 201);
});

app.patch("/api/owner/nodes/:id", async (c) => {
  assertMutation(c);
  const owner = c.get("user");
  const current = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ? AND owner_admin_id = ?").bind(c.req.param("id"), owner.id).first<NodeRow>();
  if (!current) return c.json({ error: "只能维护站长自己创建的节点" }, 404);
  if (current.status === "archived") return c.json({ error: "归档节点不可编辑" }, 400);
  const input = await body<{ name?: string; config?: unknown; archive?: boolean }>(c);
  if (input.archive) {
    await c.env.DB.prepare("UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?").bind(now(), current.id).run();
    await audit(c.env, owner.id, "node.archive", "node", current.id);
    return c.json({ ok: true });
  }
  const name = input.name?.trim() || current.name;
  const config = input.config ? validateNodeConfig(current.protocol, input.config) : JSON.parse(current.config_json);
  await c.env.DB.prepare("UPDATE nodes SET name = ?, config_json = ?, status = 'approved', updated_at = ? WHERE id = ?")
    .bind(name, JSON.stringify(config), now(), current.id).run();
  await audit(c.env, owner.id, "node.update", "node", current.id);
  return c.json({ ok: true, status: "approved" });
});

app.post("/api/owner/nodes/:id/rotate-token", async (c) => {
  assertMutation(c);
  const owner = c.get("user");
  const node = await c.env.DB.prepare("SELECT id FROM nodes WHERE id = ? AND owner_admin_id = ?").bind(c.req.param("id"), owner.id).first();
  if (!node) return c.json({ error: "只能维护站长自己创建的节点" }, 404);
  const token = randomToken(32);
  await c.env.DB.prepare("UPDATE nodes SET token_hash = ?, updated_at = ? WHERE id = ?").bind(await sha256(token), now(), c.req.param("id")).run();
  await audit(c.env, owner.id, "node.token.rotate", "node", c.req.param("id"));
  return c.json({ token });
});

app.post("/api/owner/nodes/:id/action", async (c) => {
  assertMutation(c);
  const input = await body<{ action: "approve" | "suspend" }>(c);
  if (!(["approve", "suspend"] as string[]).includes(input.action)) return c.json({ error: "操作无效" }, 400);
  const node = await c.env.DB.prepare("SELECT id, status FROM nodes WHERE id = ?").bind(c.req.param("id")).first();
  if (!node) return c.json({ error: "节点不存在" }, 404);
  const status = input.action === "approve" ? "approved" : "suspended";
  await c.env.DB.prepare("UPDATE nodes SET status = ?, updated_at = ? WHERE id = ? AND status != 'archived'").bind(status, now(), c.req.param("id")).run();
  await audit(c.env, c.get("user").id, `node.${input.action}`, "node", c.req.param("id"));
  return c.json({ ok: true, status });
});

app.get("/api/owner/plans", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, GROUP_CONCAT(pn.node_id) AS node_ids FROM plans p LEFT JOIN plan_nodes pn ON pn.plan_id = p.id GROUP BY p.id ORDER BY p.created_at DESC`,
  ).all<Record<string, unknown>>();
  return c.json({ plans: rows.results.map((row) => ({ ...row, nodeIds: row.node_ids ? String(row.node_ids).split(",") : [], node_ids: undefined })) });
});

app.post("/api/owner/plans", async (c) => {
  assertMutation(c);
  const input = await body<{ name: string; description?: string; priceCents: number; durationDays: number; quotaBytes: number; nodePoolBps?: number; nodeIds?: string[] }>(c);
  const price = Math.floor(Number(input.priceCents));
  const duration = Math.floor(Number(input.durationDays));
  const quota = Math.floor(Number(input.quotaBytes));
  const pool = Math.floor(Number(input.nodePoolBps || 0));
  if (!input.name?.trim() || price < 0 || duration < 1 || quota < 1 || pool < 0 || pool > 10000) return c.json({ error: "套餐参数无效" }, 400);
  const nodeIds = [...new Set(input.nodeIds || [])];
  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => "?").join(",");
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE status = 'approved' AND id IN (${placeholders})`).bind(...nodeIds).first<{ count: number }>();
    if (Number(count?.count) !== nodeIds.length) return c.json({ error: "套餐只能包含已审核节点" }, 400);
  }
  const id = newId("plan");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO plans (id, name, description, price_cents, duration_days, quota_bytes, node_pool_bps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.name.trim(), input.description?.trim() || "", price, duration, quota, pool, now(), now()),
    ...nodeIds.map((nodeId) => c.env.DB.prepare("INSERT INTO plan_nodes (plan_id, node_id) VALUES (?, ?)").bind(id, nodeId)),
  ]);
  await audit(c.env, c.get("user").id, "plan.create", "plan", id);
  return c.json({ id }, 201);
});

app.patch("/api/owner/plans/:id", async (c) => {
  assertMutation(c);
  const input = await body<{ name: string; description?: string; priceCents: number; durationDays: number; quotaBytes: number; nodePoolBps?: number; nodeIds?: string[]; status?: "active" | "archived" }>(c);
  const plan = await c.env.DB.prepare("SELECT id FROM plans WHERE id = ?").bind(c.req.param("id")).first();
  if (!plan) return c.json({ error: "套餐不存在" }, 404);
  const nodeIds = [...new Set(input.nodeIds || [])];
  const price = Math.floor(Number(input.priceCents));
  const duration = Math.floor(Number(input.durationDays));
  const quota = Math.floor(Number(input.quotaBytes));
  const pool = Math.floor(Number(input.nodePoolBps || 0));
  if (!input.name?.trim() || price < 0 || duration < 1 || quota < 1 || pool < 0 || pool > 10000 || !["active", "archived"].includes(input.status || "active")) {
    return c.json({ error: "套餐参数无效" }, 400);
  }
  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => "?").join(",");
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE status = 'approved' AND id IN (${placeholders})`).bind(...nodeIds).first<{ count: number }>();
    if (Number(count?.count) !== nodeIds.length) return c.json({ error: "套餐只能包含已审核节点" }, 400);
  }
  const statements = [
    c.env.DB.prepare("UPDATE plans SET name = ?, description = ?, price_cents = ?, duration_days = ?, quota_bytes = ?, node_pool_bps = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(input.name.trim(), input.description?.trim() || "", price, duration, quota, pool, input.status || "active", now(), c.req.param("id")),
    c.env.DB.prepare("DELETE FROM plan_nodes WHERE plan_id = ?").bind(c.req.param("id")),
    ...nodeIds.map((nodeId) => c.env.DB.prepare("INSERT INTO plan_nodes (plan_id, node_id) SELECT ?, id FROM nodes WHERE id = ? AND status = 'approved'").bind(c.req.param("id"), nodeId)),
  ];
  await c.env.DB.batch(statements);
  await audit(c.env, c.get("user").id, "plan.update", "plan", c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/owner/users", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.inviter_admin_id, u.created_at, GROUP_CONCAT(ur.role) AS roles,
      inviter.email AS inviter_email, ap.commission_bps FROM users u JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN users inviter ON inviter.id = u.inviter_admin_id LEFT JOIN admin_profiles ap ON ap.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`,
  ).all<Record<string, unknown>>();
  return c.json({ users: rows.results.map((row) => ({ ...row, roles: String(row.roles).split(",") })) });
});

app.patch("/api/owner/users/:id", async (c) => {
  assertMutation(c);
  const input = await body<{ status?: "active" | "disabled"; commissionBps?: number }>(c);
  const targetId = c.req.param("id");
  if (targetId === c.get("user").id && input.status === "disabled") return c.json({ error: "不能停用当前站长账号" }, 400);
  if (input.status) {
    await c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(input.status, targetId).run();
    await c.env.DB.prepare("UPDATE admin_profiles SET disabled_at = ? WHERE user_id = ?").bind(input.status === "disabled" ? now() : null, targetId).run();
  }
  if (input.commissionBps !== undefined) {
    const bps = Math.floor(Number(input.commissionBps));
    if (bps < 0 || bps > 10000) return c.json({ error: "佣金比例无效" }, 400);
    await c.env.DB.prepare("UPDATE admin_profiles SET commission_bps = ? WHERE user_id = ?").bind(bps, targetId).run();
  }
  await audit(c.env, c.get("user").id, "user.update", "user", targetId, input);
  return c.json({ ok: true });
});

app.post("/api/owner/invitations", async (c) => {
  assertMutation(c);
  const input = await body<{ expiresHours?: number }>(c);
  const invite = await createInvitation(c.env, c.get("user").id, "admin", Number(input.expiresHours || 72));
  await audit(c.env, c.get("user").id, "invitation.create", "invitation", invite.id, { role: "admin" });
  return c.json({ ...invite, url: `${c.env.APP_ORIGIN.replace(/\/$/, "")}/invite/${invite.token}` }, 201);
});

app.get("/api/owner/payment-methods", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, provider, display_name, enabled, config_json, secret_ciphertext, updated_at FROM payment_methods WHERE provider = 'alipay' LIMIT 1",
  ).first<{ id: string; provider: string; display_name: string; enabled: number; config_json: string; secret_ciphertext: string; updated_at: number }>();
  if (row) {
    const config = JSON.parse(row.config_json || "{}") as Record<string, string>;
    let appId = "";
    try { appId = (await openPaymentSecrets(row.secret_ciphertext, c.env.SESSION_SECRET)).appId || ""; } catch { /* The UI still lets the owner replace broken credentials. */ }
    return c.json({
      methods: [{ id: row.id, provider: row.provider, displayName: row.display_name, enabled: Boolean(row.enabled), gateway: config.gateway || "", appId, hasCredentials: Boolean(row.secret_ciphertext), source: "database", updatedAt: row.updated_at }],
      supportedProviders: [{ id: "alipay", name: "支付宝当面付", available: true }],
    });
  }
  const configured = Boolean(c.env.ALIPAY_APP_ID && c.env.ALIPAY_PRIVATE_KEY && c.env.ALIPAY_PUBLIC_KEY);
  return c.json({
    methods: configured ? [{ id: null, provider: "alipay", displayName: "支付宝", enabled: true, gateway: c.env.ALIPAY_GATEWAY, appId: c.env.ALIPAY_APP_ID, hasCredentials: true, source: "environment", updatedAt: null }] : [],
    supportedProviders: [{ id: "alipay", name: "支付宝当面付", available: true }],
  });
});

app.put("/api/owner/payment-methods/alipay", async (c) => {
  assertMutation(c);
  const input = await body<{ displayName?: string; enabled?: boolean; gateway?: string; appId?: string; privateKey?: string; publicKey?: string }>(c);
  const displayName = String(input.displayName || "支付宝").trim();
  if (!displayName || displayName.length > 40) return c.json({ error: "支付方式名称不能为空且最多 40 字" }, 400);
  let gateway: URL;
  try { gateway = new URL(String(input.gateway || "https://openapi.alipay.com/gateway.do")); }
  catch { return c.json({ error: "支付宝网关地址无效" }, 400); }
  if (gateway.protocol !== "https:") return c.json({ error: "支付宝网关必须使用 HTTPS" }, 400);

  const current = await c.env.DB.prepare("SELECT secret_ciphertext FROM payment_methods WHERE provider = 'alipay' LIMIT 1")
    .first<{ secret_ciphertext: string }>();
  let secrets: Record<string, string> = { appId: c.env.ALIPAY_APP_ID || "", privateKey: c.env.ALIPAY_PRIVATE_KEY || "", publicKey: c.env.ALIPAY_PUBLIC_KEY || "" };
  if (current?.secret_ciphertext) {
    try { secrets = await openPaymentSecrets(current.secret_ciphertext, c.env.SESSION_SECRET); }
    catch {
      if (!input.appId?.trim() || !input.privateKey?.trim() || !input.publicKey?.trim()) throw new Error("原支付配置无法解密，请重新填写全部支付凭据");
    }
  }
  secrets = {
    appId: String(input.appId || "").trim() || secrets.appId,
    privateKey: String(input.privateKey || "").trim() || secrets.privateKey,
    publicKey: String(input.publicKey || "").trim() || secrets.publicKey,
  };
  if (input.enabled !== false && (!secrets.appId || !secrets.privateKey || !secrets.publicKey)) return c.json({ error: "启用支付宝前必须填写应用 ID、应用私钥和支付宝公钥" }, 400);
  if (secrets.privateKey && !secrets.privateKey.includes("PRIVATE KEY")) return c.json({ error: "支付宝应用私钥必须是 PEM 格式" }, 400);
  if (secrets.publicKey && !secrets.publicKey.includes("PUBLIC KEY")) return c.json({ error: "支付宝公钥必须是 PEM 格式" }, 400);

  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending' AND cash_cents > 0 AND expires_at > ?")
    .bind(now()).first<{ count: number }>();
  if (Number(pending?.count || 0) > 0) return c.json({ error: "仍有未完成的支付订单，请等待订单完成或过期后再修改支付配置" }, 409);

  const actorId = c.get("user").id;
  const timestamp = now();
  await c.env.DB.prepare(
    `INSERT INTO payment_methods (id, provider, display_name, enabled, config_json, secret_ciphertext, created_by, updated_by, created_at, updated_at)
     VALUES ('pay_alipay', 'alipay', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET display_name = excluded.display_name, enabled = excluded.enabled, config_json = excluded.config_json,
       secret_ciphertext = excluded.secret_ciphertext, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(displayName, input.enabled === false ? 0 : 1, JSON.stringify({ gateway: gateway.toString() }), await sealPaymentSecrets(secrets, c.env.SESSION_SECRET), actorId, actorId, timestamp, timestamp).run();
  await audit(c.env, actorId, "payment_method.update", "payment_method", "pay_alipay", { provider: "alipay", enabled: input.enabled !== false, gateway: gateway.toString() });
  return c.json({ ok: true });
});

app.get("/api/owner/orders", async (c) => {
  const rows = await c.env.DB.prepare("SELECT o.*, u.email, p.name AS plan_name FROM orders o JOIN users u ON u.id = o.user_id JOIN plans p ON p.id = o.plan_id ORDER BY o.created_at DESC LIMIT 500").all();
  return c.json({ orders: rows.results });
});

app.get("/api/owner/withdrawals", async (c) => {
  const rows = await c.env.DB.prepare("SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id = w.admin_id ORDER BY w.created_at DESC").all();
  return c.json({ withdrawals: rows.results });
});

app.post("/api/owner/withdrawals/:id/action", async (c) => {
  assertMutation(c);
  const owner = c.get("user");
  const input = await body<{ action: "paid" | "reject"; transferReference?: string }>(c);
  const withdrawal = await c.env.DB.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").bind(c.req.param("id"))
    .first<{ id: string; admin_id: string; amount_cents: number }>();
  if (!withdrawal) return c.json({ error: "提现申请不存在或已处理" }, 404);
  if (input.action === "paid") {
    if (!input.transferReference?.trim()) return c.json({ error: "转账流水号不能为空" }, 400);
    await c.env.DB.prepare("UPDATE withdrawals SET status = 'paid', transfer_reference = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .bind(input.transferReference.trim(), owner.id, now(), withdrawal.id).run();
  } else if (input.action === "reject") {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE withdrawals SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(owner.id, now(), withdrawal.id),
      c.env.DB.prepare("INSERT INTO earnings_ledger (id, admin_id, kind, amount_cents, available_at, metadata_json, created_at) VALUES (?, ?, 'withdrawal_release', ?, ?, ?, ?)")
        .bind(newId("earn"), withdrawal.admin_id, withdrawal.amount_cents, now(), JSON.stringify({ withdrawal_id: withdrawal.id }), now()),
    ]);
  } else return c.json({ error: "操作无效" }, 400);
  await audit(c.env, owner.id, `withdrawal.${input.action}`, "withdrawal", withdrawal.id, { transferReference: input.transferReference });
  return c.json({ ok: true });
});

app.get("/api/owner/audit", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT a.*, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 500",
  ).all();
  return c.json({ logs: rows.results });
});

async function nodeFromRequest(env: Env, authorization: string | undefined): Promise<NodeRow | null> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  return env.DB.prepare("SELECT * FROM nodes WHERE token_hash = ? AND status != 'archived'").bind(await sha256(token)).first<NodeRow>();
}

app.get("/api/node/v1/config", async (c) => {
  const node = await nodeFromRequest(c.env, c.req.header("Authorization"));
  if (!node) return c.json({ error: "节点令牌无效" }, 401);
  const timestamp = now();
  const users = node.status === "approved" ? await c.env.DB.prepare(
    `SELECT DISTINCT u.id, u.access_uuid, u.access_secret, e.ends_at, e.quota_bytes,
      COALESCE(q.up_bytes, 0) + COALESCE(q.down_bytes, 0) AS used_bytes
     FROM entitlements e
     JOIN users u ON u.id = e.user_id
     JOIN plan_nodes pn ON pn.plan_id = e.plan_id AND pn.node_id = ?
     LEFT JOIN quota_usage q ON q.user_id = u.id AND q.month_key = ?
     WHERE e.status = 'active' AND e.starts_at <= ? AND e.ends_at > ? AND u.status = 'active'
       AND COALESCE(q.up_bytes, 0) + COALESCE(q.down_bytes, 0) < e.quota_bytes`,
  ).bind(node.id, monthKey(), timestamp, timestamp).all<Record<string, unknown>>() : { results: [] };
  return c.json({
    node: { id: node.id, name: node.name, protocol: node.protocol, status: node.status, config: JSON.parse(node.config_json), updatedAt: node.updated_at },
    users: users.results.map((user) => ({ id: user.id, uuid: user.access_uuid, secret: user.access_secret, expiresAt: user.ends_at, quotaBytes: user.quota_bytes, usedBytes: user.used_bytes })),
    generatedAt: timestamp,
  });
});

app.post("/api/node/v1/heartbeat", async (c) => {
  const node = await nodeFromRequest(c.env, c.req.header("Authorization"));
  if (!node) return c.json({ error: "节点令牌无效" }, 401);
  const input = await body<{ onlineCount?: number; version?: string }>(c);
  const online = Math.max(0, Math.min(1_000_000, Math.floor(Number(input.onlineCount || 0))));
  await c.env.DB.prepare("UPDATE nodes SET last_seen_at = ?, online_count = ?, agent_version = ? WHERE id = ?")
    .bind(now(), online, String(input.version || "").slice(0, 80), node.id).run();
  return c.json({ ok: true, serverTime: now(), status: node.status });
});

app.post("/api/node/v1/usage", async (c) => {
  const node = await nodeFromRequest(c.env, c.req.header("Authorization"));
  if (!node) return c.json({ error: "节点令牌无效" }, 401);
  if (node.status !== "approved") return c.json({ error: "节点尚未审核或已停用" }, 403);
  const input = await body<{ reportId: string; entries: Array<{ userId: string; upBytes: number; downBytes: number }> }>(c);
  if (!input.reportId?.trim() || input.reportId.length > 120 || !Array.isArray(input.entries) || input.entries.length > 40) {
    return c.json({ error: "流量报告格式无效，单次最多 40 条" }, 400);
  }
  const duplicate = await c.env.DB.prepare("SELECT 1 FROM usage_reports WHERE node_id = ? AND report_id = ?").bind(node.id, input.reportId).first();
  if (duplicate) return c.json({ accepted: false, duplicate: true });
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO usage_reports (report_id, node_id, reported_at) VALUES (?, ?, ?)").bind(input.reportId, node.id, timestamp),
  ];
  let accepted = 0;
  for (const entry of input.entries) {
    const up = Math.floor(Number(entry.upBytes));
    const down = Math.floor(Number(entry.downBytes));
    if (!entry.userId || !Number.isSafeInteger(up) || !Number.isSafeInteger(down) || up < 0 || down < 0 || up + down === 0) continue;
    const entitlement = await c.env.DB.prepare(
      `SELECT e.id FROM entitlements e JOIN plan_nodes pn ON pn.plan_id = e.plan_id
       WHERE e.user_id = ? AND pn.node_id = ? AND e.status = 'active' AND e.starts_at <= ? AND e.ends_at > ? LIMIT 1`,
    ).bind(entry.userId, node.id, timestamp, timestamp).first<{ id: string }>();
    if (!entitlement) continue;
    statements.push(
      c.env.DB.prepare("INSERT INTO usage_entries (id, report_id, node_id, user_id, entitlement_id, up_bytes, down_bytes, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(newId("usage"), input.reportId, node.id, entry.userId, entitlement.id, up, down, timestamp),
      c.env.DB.prepare(
        `INSERT INTO quota_usage (user_id, month_key, up_bytes, down_bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, month_key) DO UPDATE SET up_bytes = up_bytes + excluded.up_bytes, down_bytes = down_bytes + excluded.down_bytes`,
      ).bind(entry.userId, monthKey(timestamp), up, down),
    );
    accepted++;
  }
  try { await c.env.DB.batch(statements); }
  catch (error) {
    const after = await c.env.DB.prepare("SELECT 1 FROM usage_reports WHERE node_id = ? AND report_id = ?").bind(node.id, input.reportId).first();
    if (after) return c.json({ accepted: false, duplicate: true });
    throw error;
  }
  return c.json({ accepted: true, entries: accepted });
});

app.get("/sub/:token", async (c) => {
  const parsed = await verifySubscriptionToken(c.env.SESSION_SECRET, c.req.param("token"));
  if (!parsed) return c.text("订阅链接无效", 404);
  const user = await loadUser(c.env, parsed.userId);
  if (!user || user.status !== "active" || user.subscriptionVersion !== parsed.version) return c.text("订阅链接已失效", 410);
  const timestamp = now();
  const entitlement = await c.env.DB.prepare(
    "SELECT id, plan_id, quota_bytes FROM entitlements WHERE user_id = ? AND status = 'active' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1",
  ).bind(user.id, timestamp, timestamp).first<{ id: string; plan_id: string; quota_bytes: number }>();
  if (!entitlement) return c.text("当前没有有效套餐", 403);
  const usage = await c.env.DB.prepare("SELECT up_bytes + down_bytes AS used FROM quota_usage WHERE user_id = ? AND month_key = ?")
    .bind(user.id, monthKey(timestamp)).first<{ used: number }>();
  if (Number(usage?.used || 0) >= entitlement.quota_bytes) return c.text("本月流量已用尽", 403);
  const nodes = await c.env.DB.prepare(
    `SELECT n.* FROM nodes n JOIN plan_nodes pn ON pn.node_id = n.id
     JOIN users owner ON owner.id = n.owner_admin_id
     LEFT JOIN admin_profiles ap ON ap.user_id = n.owner_admin_id
     WHERE pn.plan_id = ? AND n.status = 'approved' AND owner.status = 'active' AND ap.disabled_at IS NULL ORDER BY n.name`,
  ).bind(entitlement.plan_id).all<NodeRow>();
  try {
    const result = renderSubscription(c.req.query("target") || "clash", nodes.results, { uuid: user.accessUuid, secret: user.accessSecret });
    const headers = new Headers({ "content-type": result.contentType, "cache-control": "no-store, private", "subscription-userinfo": `upload=${Number(usage?.used || 0)}; download=0; total=${entitlement.quota_bytes}` });
    if (result.skipped.length) headers.set("x-boardless-skipped", encodeURIComponent(result.skipped.join(",")));
    return new Response(result.body, { headers });
  } catch (error) { return c.text(error instanceof Error ? error.message : "订阅生成失败", 400); }
});

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(settleExpiredEntitlements(env).then((count) => console.log(`settled ${count} entitlements`)));
  },
};
