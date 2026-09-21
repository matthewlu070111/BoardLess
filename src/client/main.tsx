import React, { createContext, FormEvent, ReactNode, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";

type Role = "user" | "admin" | "owner";
type User = { id: string; email: string; roles: Role[]; status: string; inviterAdminId: string | null };
type SiteMode = "plan" | "direct";
type Json = Record<string, any>;

async function api<T = Json>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({ error: "服务器返回了无效响应" })) as Json;
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

const AuthContext = createContext<{ user: User | null; siteMode: SiteMode; loading: boolean; refresh(): Promise<void>; logout(): Promise<void> } | null>(null);

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [siteMode, setSiteMode] = useState<SiteMode>("plan");
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try { const result = await api<{ user: User; siteMode: SiteMode }>("/api/me"); setUser(result.user); setSiteMode(result.siteMode); }
    catch { setUser(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  const logout = async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); setUser(null); };
  return <AuthContext.Provider value={{ user, siteMode, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider missing");
  return value;
}

function Login({ admin = false }: { admin?: boolean }) {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (user) {
    const allowed = user.roles.some((role) => role === "admin" || role === "owner");
    return <Navigate to={admin && allowed ? (user.roles.includes("owner") ? "/owner" : "/admin") : "/app"} replace />;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, portal: admin ? "admin" : "user" }) });
      await refresh();
      navigate(admin ? (result.user.roles.includes("owner") ? "/owner" : "/admin") : "/app");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <section className="auth-card">
      <div className="brand brand-large"><span>B</span> BoardLess</div>
      <div className="auth-heading"><p className="eyebrow">{admin ? "管理入口" : "用户中心"}</p><h1>{admin ? "登录管理后台" : "欢迎回来"}</h1></div>
      <form onSubmit={submit} className="form-stack">
        <Field label="邮箱"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
        <Field label="密码"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入密码" /></Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="button primary full" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
      </form>
      <div className="auth-switch">{admin ? <Link to="/login">返回用户登录</Link> : <Link to="/admin/login">站长 / 管理员入口</Link>}</div>
    </section>
  </main>;
}

function Invite() {
  const { token = "" } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<Json | null>(null);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  useEffect(() => { api(`/api/invitations/${token}`).then(setInvite).catch((e) => setError(e.message)); }, [token]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { const result = await api<{ user: User }>(`/api/invitations/${token}/accept`, { method: "POST", body: JSON.stringify({ email, password }) }); await refresh(); navigate(result.user.roles.includes("admin") ? "/admin" : "/app"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "注册失败"); }
  };
  return <main className="auth-page"><section className="auth-card">
    <div className="brand brand-large"><span>B</span> BoardLess</div>
    <div className="auth-heading"><p className="eyebrow">仅限受邀用户</p><h1>接受{invite?.role === "admin" ? "管理员" : "用户"}邀请</h1>{invite && <p>邀请人：{invite.inviterEmail}</p>}</div>
    {error && !invite ? <Notice tone="danger">{error}</Notice> : <form className="form-stack" onSubmit={submit}>
      <Field label="邮箱"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="设置密码"><input type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 10 位" /></Field>
      {error && <Notice tone="danger">{error}</Notice>}<button className="button primary full">创建账号</button>
    </form>}
  </section></main>;
}

type NavItem = { to: string; label: string; icon: string };
const userNav = (siteMode: SiteMode): NavItem[] => [
  { to: "/app", label: "概览", icon: "⌂" }, ...(siteMode === "plan" ? [{ to: "/app/plans", label: "购买套餐", icon: "◇" }] : []),
  { to: "/app/subscription", label: "订阅", icon: "↗" }, { to: "/app/usage", label: "流量", icon: "▥" }, { to: "/app/orders", label: "历史订单", icon: "▤" },
];
const adminNav = (siteMode: SiteMode): NavItem[] => [
  { to: "/admin", label: "概览", icon: "⌂" }, { to: "/admin/nodes", label: "我的节点", icon: "⌘" },
  { to: "/admin/users", label: "邀请用户", icon: "♙" }, ...(siteMode === "plan" ? [{ to: "/admin/earnings", label: "收益与提现", icon: "¥" }] : []),
];
const ownerNav = (siteMode: SiteMode): NavItem[] => [
  { to: "/owner", label: "全站概览", icon: "⌂" }, { to: "/owner/nodes", label: "节点管理", icon: "⌘" },
  { to: "/owner/backends", label: "后端仓库", icon: "↯" },
  ...(siteMode === "plan" ? [{ to: "/owner/plans", label: "套餐编排", icon: "◇" }] : [{ to: "/owner/grants", label: "节点授权", icon: "◇" }]),
  { to: "/owner/users", label: "账号管理", icon: "♙" },
  ...(siteMode === "plan" ? [{ to: "/owner/payments", label: "支付对接", icon: "¤" }, { to: "/owner/orders", label: "订单", icon: "▤" }, { to: "/owner/withdrawals", label: "提现审核", icon: "¥" }] : []),
  { to: "/owner/audit", label: "审计日志", icon: "◉" }, { to: "/owner/settings", label: "系统设置", icon: "⚙" },
];

function Protected({ role, children }: { role?: "admin" | "owner"; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading full />;
  if (!user) return <Navigate to={role ? "/admin/login" : "/login"} replace />;
  if (role && !user.roles.includes(role)) return <Navigate to={user.roles.includes("owner") ? "/owner" : user.roles.includes("admin") ? "/admin" : "/app"} replace />;
  return <>{children}</>;
}

function ModeOnly({ siteMode: required, children }: { siteMode: SiteMode; children: ReactNode }) {
  const { user, siteMode } = useAuth();
  const fallback = user?.roles.includes("owner") ? "/owner" : user?.roles.includes("admin") ? "/admin" : "/app";
  return siteMode === required ? <>{children}</> : <Navigate to={fallback} replace />;
}

function Shell({ mode, children }: { mode: "user" | "admin" | "owner"; children: ReactNode }) {
  const { user, siteMode, logout } = useAuth();
  const location = useLocation(); const navigate = useNavigate(); const [open, setOpen] = useState(false);
  const nav = mode === "user" ? userNav(siteMode) : mode === "admin" ? adminNav(siteMode) : ownerNav(siteMode);
  const title = mode === "user" ? "用户中心" : mode === "admin" ? "节点管理" : "站长控制台";
  return <div className="app-shell">
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><span>B</span> BoardLess</div><div className="workspace-label">{title}</div>
      <nav>{nav.map((item) => <Link key={item.to} to={item.to} onClick={() => setOpen(false)} className={location.pathname === item.to ? "active" : ""}><i>{item.icon}</i>{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        {mode !== "user" && <button className="switch-link" onClick={() => navigate("/app")}>切换到用户中心</button>}
        {mode === "user" && user?.roles.includes("owner") && <button className="switch-link" onClick={() => navigate("/owner")}>进入站长控制台</button>}
        {mode === "user" && !user?.roles.includes("owner") && user?.roles.includes("admin") && <button className="switch-link" onClick={() => navigate("/admin")}>进入节点管理</button>}
        <div className="account"><div className="avatar">{user?.email[0].toUpperCase()}</div><div><strong>{user?.email}</strong><small>{mode === "owner" ? "站长" : mode === "admin" ? "管理员" : "用户"}</small></div><button onClick={logout} title="退出">↪</button></div>
      </div>
    </aside>
    <div className="main-column"><header className="mobile-header"><button onClick={() => setOpen(!open)}>☰</button><div className="brand"><span>B</span> BoardLess</div></header><main className="content">{children}</main></div>
    {open && <button aria-label="关闭菜单" className="backdrop" onClick={() => setOpen(false)} />}
  </div>;
}

function Page({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <><header className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>{children}</>;
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "danger" | "success" }) { return <div className={`notice ${tone}`}>{children}</div>; }
function Loading({ full = false }: { full?: boolean }) { return <div className={full ? "loading full-loading" : "loading"}><span />加载中…</div>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty"><div>◇</div><p>{children}</p></div>; }
function Badge({ value }: { value: string }) { const labels: Record<string, string> = { active: "有效", enabled: "已启用", paid: "已支付", pending: "待确认", approved: "已审核", suspended: "已停用", archived: "已归档", expired: "已过期", cancelled: "已取消", disabled: "已停用", review: "需复核", closed: "已关闭", rejected: "已驳回" }; return <span className={`badge ${value}`}>{labels[value] || value}</span>; }
const money = (cents: number) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const bytes = (value: number) => { const units = ["B", "KB", "MB", "GB", "TB"]; let size = Number(value || 0), unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size.toFixed(unit > 2 ? 2 : 1)} ${units[unit]}`; };
const date = (value: number) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value * 1000)) : "—";
const datetimeInput = (value: number | null | undefined) => value ? new Date(value * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";

function UserDashboard() {
  const [data, setData] = useState<Json | null>(null);
  useEffect(() => { api("/api/app/dashboard").then(setData); }, []);
  if (!data) return <Loading />;
  if (data.siteMode === "direct") {
    const active = data.grants.filter((grant: Json) => grant.active);
    return <Page title="概览" description="逐节点授权状态与使用情况">
      <div className="stat-grid four"><Stat label="有效节点" value={String(active.length)} hint={`共分配 ${data.grants.length} 个节点`} /><Stat label="不限期节点" value={String(active.filter((grant: Json) => !grant.expiresAt).length)} /><Stat label="不限量节点" value={String(active.filter((grant: Json) => !grant.quotaBytes).length)} /><Stat label="历史订单" value={String(data.orderCount)} hint="仅供历史查询" /></div>
      <section className="panel"><div className="row-between"><div><p className="eyebrow">逐节点授权</p><h2>我的节点</h2></div><Link className="button primary" to="/app/subscription">获取订阅</Link></div><div className="grant-grid">{data.grants.map((grant: Json) => { const percent = grant.quotaBytes ? Math.min(100, grant.usedBytes / grant.quotaBytes * 100) : 0; return <article className="grant-card" key={grant.nodeId}><div className="row-between"><strong>{grant.name}</strong><Badge value={grant.active ? "active" : "expired"} /></div><p>{String(grant.protocol).toUpperCase()} · {grant.multiplier}x 倍率</p><p>{grant.expiresAt ? `${date(grant.expiresAt)} 到期` : "不限期"} · {grant.quotaBytes ? `${grant.quotaCycle === "monthly" ? "每月" : "授权期"} ${bytes(grant.quotaBytes)}` : "不限流量"}</p>{grant.quotaBytes && <><div className="progress"><span style={{ width: `${percent}%` }} /></div><small>{bytes(grant.usedBytes)} / {bytes(grant.quotaBytes)}</small></>}</article>; })}</div>{!data.grants.length && <Empty>站长尚未分配节点</Empty>}</section>
    </Page>;
  }
  const used = Number(data.usage.up_bytes || 0) + Number(data.usage.down_bytes || 0);
  const quota = Number(data.entitlement?.quota_bytes || 0);
  const percent = quota ? Math.min(100, used / quota * 100) : 0;
  return <Page title="概览" description="订阅状态、流量和账户余额">
    <div className="stat-grid four">
      <Stat label="当前套餐" value={data.entitlement?.plan_name || "未开通"} hint={data.entitlement ? `${date(data.entitlement.ends_at)} 到期` : "购买套餐后开始使用"} />
      <Stat label="本月已用" value={bytes(used)} hint={quota ? `共 ${bytes(quota)}` : "暂无额度"} />
      <Stat label="钱包余额" value={money(data.walletCents)} hint="仅可抵扣套餐订单" />
      <Stat label="历史订单" value={String(data.orderCount)} hint="支付及续费记录" />
    </div>
    <section className="panel feature-panel"><div><p className="eyebrow">自然月流量</p><h2>{bytes(used)} <small>/ {bytes(quota)}</small></h2><div className="progress"><span style={{ width: `${percent}%` }} /></div><p className="muted">每月 1 日自动重置，达到额度后节点会停止授权。</p></div><div className="quick-actions"><Link className="button primary" to="/app/subscription">获取订阅</Link><Link className="button" to="/app/plans">续费 / 升级</Link></div></section>
  </Page>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) { return <article className="stat"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>; }

function Plans() {
  const [plans, setPlans] = useState<Json[]>([]); const [payment, setPayment] = useState<Json | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => { api<{ plans: Json[] }>("/api/app/plans").then((r) => setPlans(r.plans)); }, []);
  useEffect(() => {
    if (!payment || payment.status !== "pending") return;
    const timer = setInterval(async () => { try { const result = await api<Json>(`/api/app/orders/${payment.orderId}`); if (result.order.status !== "pending") setPayment((current) => current ? { ...current, status: result.order.status } : null); } catch {} }, 3000);
    return () => clearInterval(timer);
  }, [payment]);
  const purchase = async (planId: string) => {
    setBusy(planId); setError("");
    try { setPayment(await api("/api/app/orders", { method: "POST", body: JSON.stringify({ planId }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "创建订单失败"); }
    finally { setBusy(""); }
  };
  return <Page title="购买套餐" description="续费会顺延；更换套餐立即生效，剩余价值转入钱包">
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="card-grid plans">{plans.map((plan) => <article className="plan-card" key={plan.id}>
      <div><Badge value={plan.status} /><h2>{plan.name}</h2><p>{plan.description || "稳定、简洁的订阅服务"}</p></div>
      <div className="price"><span>¥</span>{(plan.price_cents / 100).toFixed(2)}<small> / {plan.duration_days} 天</small></div>
      <ul><li><b>{bytes(plan.quota_bytes)}</b> 每自然月</li><li><b>{plan.node_count}</b> 个可用节点</li><li>节点池比例 {(plan.node_pool_bps / 100).toFixed(2)}%</li></ul>
      <button className="button primary full" disabled={busy === plan.id} onClick={() => purchase(plan.id)}>{busy === plan.id ? "创建订单…" : "选择套餐"}</button>
    </article>)}</div>
    {!plans.length && <Empty>暂无可购买套餐</Empty>}
    {payment && <div className="modal-layer"><section className="modal payment-modal"><button className="modal-close" onClick={() => setPayment(null)}>×</button>
      {payment.status === "paid" ? <div className="payment-success"><div>✓</div><h2>套餐已生效</h2><p>已使用钱包 {money(payment.walletCents)}，支付宝支付 {money(payment.cashCents)}。</p><Link className="button primary" to="/app/subscription" onClick={() => setPayment(null)}>查看订阅</Link></div> : payment.status !== "pending" ? <div className="payment-success"><div>!</div><h2>订单{payment.status === "expired" ? "已过期" : "未完成"}</h2><button className="button" onClick={() => setPayment(null)}>关闭</button></div> : <>
        <p className="eyebrow">{payment.paymentName || "支付宝"}</p><h2>扫码完成支付</h2><div className="payment-amount">{money(payment.cashCents)}</div>{payment.qrImage && <img src={payment.qrImage} alt={`${payment.paymentName || "支付宝"}支付二维码`} className="qr" />}<p className="muted">钱包抵扣 {money(payment.walletCents)}{payment.upgradeCredit ? `，含升级折算 ${money(payment.upgradeCredit)}` : ""}</p><button className="button" onClick={() => api(`/api/app/orders/${payment.orderId}/query`, { method: "POST", body: "{}" }).then((r: any) => setPayment({ ...payment, status: r.status }))}>我已支付，查询状态</button>
      </>}
    </section></div>}
  </Page>;
}

function Subscription() {
  const [data, setData] = useState<Json | null>(null); const [notice, setNotice] = useState(""); const [danger, setDanger] = useState<DangerAction | null>(null);
  const load = () => api("/api/app/subscription").then(setData);
  useEffect(() => { void load(); }, []);
  const copy = async (target: string) => { if (!data) return; await navigator.clipboard.writeText(`${data.baseUrl}?target=${target}`); setNotice(`已复制 ${target} 订阅链接`); setTimeout(() => setNotice(""), 1800); };
  const rotate = () => setDanger({ title: "轮换订阅链接", description: "轮换后旧订阅链接会立即失效，所有设备都需要更新订阅地址。", confirmLabel: "确认轮换", run: async () => { await api("/api/app/subscription/rotate", { method: "POST", body: "{}" }); await load(); setNotice("订阅链接已轮换"); } });
  if (!data) return <Loading />;
  return <Page title="订阅" description="按客户端复制对应格式；订阅链接等同密码，请勿公开" action={<button className="button danger-ghost" onClick={rotate}>轮换链接</button>}>
    {notice && <Notice tone="success">{notice}</Notice>}
    {!data.active && <Notice tone="danger">当前没有可用的套餐或节点授权，订阅暂不可用。</Notice>}
    <div className="card-grid targets">{[
      ["clash", "Clash Meta", "YAML · 通用精细分流"], ["shadowrocket", "Shadowrocket", "节点订阅"], ["singbox", "sing-box", "JSON · 通用精细分流"], ["surge", "Surge", "SS / Trojan"],
    ].map(([id, name, meta]) => <article className="target-card" key={id}><div className="target-icon">{name[0]}</div><div><h3>{name}</h3><p>{meta}</p></div><button className="button" disabled={!data.active} onClick={() => copy(id)}>复制链接</button></article>)}</div>
    <section className="panel"><h2>兼容说明</h2><p className="muted">Clash Meta 与 sing-box 输出包含 AI、流媒体、社交、开发、办公、游戏平台等独立策略组，以及私网 / 国内直连和漏网流量策略，并支持全部六类协议。规则集每天由客户端自动更新。Shadowrocket 输出普通节点订阅，不附带分流规则。Surge 仅输出 Shadowsocks 和 Trojan；不兼容节点会通过响应头标明。</p></section>
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function Usage() {
  const [data, setData] = useState<Json | null>(null); useEffect(() => { api<Json>("/api/app/usage").then(setData); }, []);
  if (!data) return <Loading />;
  const rows = data.usage as Json[];
  if (data.siteMode === "direct") return <Page title="流量明细" description="逐节点展示原始流量与倍率折算流量"><section className="panel table-wrap"><table><thead><tr><th>月份</th><th>节点</th><th>原始上行</th><th>原始下行</th><th>额度计费</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.month_key}:${row.node_id}`}><td>{row.month_key}</td><td>{row.node_name}</td><td>{bytes(row.up_bytes)}</td><td>{bytes(row.down_bytes)}</td><td><strong>{bytes(row.charged_up_bytes + row.charged_down_bytes)}</strong></td></tr>)}</tbody></table>{!rows.length && <Empty>暂无流量记录</Empty>}</section></Page>;
  return <Page title="流量明细" description="按自然月统计节点上报的上下行流量"><section className="panel table-wrap"><table><thead><tr><th>月份</th><th>上行</th><th>下行</th><th>合计</th></tr></thead><tbody>{rows.map((row) => <tr key={row.month_key}><td>{row.month_key}</td><td>{bytes(row.up_bytes)}</td><td>{bytes(row.down_bytes)}</td><td><strong>{bytes(row.up_bytes + row.down_bytes)}</strong></td></tr>)}</tbody></table>{!rows.length && <Empty>暂无流量记录</Empty>}</section></Page>;
}

function Orders() {
  const [rows, setRows] = useState<Json[] | null>(null); useEffect(() => { api<{ orders: Json[] }>("/api/app/orders").then((r) => setRows(r.orders)); }, []);
  if (!rows) return <Loading />;
  return <Page title="订单" description="支付宝付款与钱包抵扣记录"><section className="panel table-wrap"><table><thead><tr><th>订单</th><th>套餐</th><th>金额</th><th>支付构成</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="mono">{row.id.slice(-10)}</td><td>{row.plan_name}</td><td>{money(row.price_cents)}</td><td>支付宝 {money(row.cash_cents)} · 钱包 {money(row.wallet_cents)}</td><td><Badge value={row.status} /></td><td>{date(row.created_at)}</td></tr>)}</tbody></table>{!rows.length && <Empty>暂无订单</Empty>}</section></Page>;
}

function AdminDashboard() {
  const { siteMode } = useAuth();
  const [data, setData] = useState<Json | null>(null); useEffect(() => { api("/api/admin/overview").then(setData); }, []);
  if (!data) return <Loading />;
  return <Page title="管理员概览" description={siteMode === "plan" ? "你的节点、用户与可提现收益" : "逐节点授权站点中的节点和用户"}><div className={`stat-grid ${siteMode === "plan" ? "four" : ""}`}><Stat label="节点" value={String(data.nodeCount)} hint="仅你可以维护配置" /><Stat label="邀请用户" value={String(data.invitedUsers)} hint="归属关系固定" />{siteMode === "plan" && <><Stat label="可提现" value={money(data.availableCents)} hint="最低 ¥100" /><Stat label="待处理提现" value={String(data.pendingWithdrawals)} hint="由站长人工核销" /></>}</div><section className="panel"><h2>节点接入流程</h2><div className="steps"><span><b>1</b> 选择站长启用的节点后端</span><span><b>2</b> 按后端提供的表单完成配置</span><span><b>3</b> 在服务器执行一次性安装命令</span><span><b>4</b> 等待站长审核{siteMode === "plan" ? "并加入套餐" : "并由站长分配给用户"}</span></div></section></Page>;
}

type DangerAction = {
  title: string;
  description?: string;
  summary?: ReactNode;
  impacts?: string[];
  confirmLabel: string;
  force?: { name: string; description: string; confirmLabel: string };
  run(force: boolean): Promise<void>;
};

function DangerDialog({ action, onClose }: { action: DangerAction | null; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [force, setForce] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => { setBusy(false); setError(""); setForce(false); setConfirmation(""); }, [action]);
  if (!action) return null;
  const forceConfirmed = !action.force || confirmation === action.force.name;
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await action.run(force); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); } finally { setBusy(false); } };
  return <div className="modal-layer" role="presentation"><form className="modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="danger-dialog-title" onSubmit={submit}>
    <button type="button" className="modal-close" aria-label="关闭" disabled={busy} onClick={onClose}>×</button>
    <div className="delete-modal-icon">!</div><p className="eyebrow">请确认此操作</p><h2 id="danger-dialog-title">{action.title}</h2>
    {action.description && <p className="muted">{action.description}</p>}{action.summary && <div className="delete-node-summary">{action.summary}</div>}
    {action.impacts?.length ? <ul className="delete-impact">{action.impacts.map((impact) => <li key={impact}>{impact}</li>)}</ul> : null}
    {action.force && <label className={`force-delete-option ${force ? "selected" : ""}`}><input type="checkbox" checked={force} disabled={busy} onChange={(event) => setForce(event.target.checked)} /><span><strong>强制删除</strong><small>{action.force.description}</small></span></label>}
    {action.force && force && <Field label={`输入名称“${action.force.name}”以确认`} hint="名称必须完全一致"><input autoFocus value={confirmation} disabled={busy} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} /></Field>}
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy || (force && !forceConfirmed)}>{busy ? "正在处理…" : force && action.force ? action.force.confirmLabel : action.confirmLabel}</button></div>
  </form></div>;
}

function TrafficSummary({ node }: { node: Json }) {
  if (!node.trafficSupported) return null;
  if (!node.traffic) return <small className="cell-sub">流量额度：未配置</small>;
  return <small className="cell-sub">{node.traffic.available ? "可用" : "额度耗尽"} · 上 {bytes(node.traffic.upBytes)} / 下 {bytes(node.traffic.downBytes)} · 计费 {bytes(node.traffic.usedBytes)} / {bytes(node.traffic.limitBytes)} · {date(node.traffic.nextResetAt)} 重置</small>;
}

function TrafficDialog({ node, onClose, onSaved }: { node: Json | null; onClose(): void; onSaved(): Promise<void> }) {
  const [limitGb, setLimitGb] = useState(""); const [resetDay, setResetDay] = useState("1"); const [direction, setDirection] = useState("both");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setLimitGb(node?.traffic ? String(node.traffic.limitBytes / 1024 ** 3) : ""); setResetDay(String(node?.traffic?.resetDay || 1)); setDirection(node?.traffic?.direction || "both"); setError(""); }, [node]);
  if (!node) return null;
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await api(`/api/deploy/nodes/${node.id}/traffic`, { method: "PUT", body: JSON.stringify({ limitBytes: Math.round(Number(limitGb) * 1024 ** 3), resetDay: Number(resetDay), direction }) }); await onSaved(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); } finally { setBusy(false); } };
  return <div className="modal-layer"><form className="modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose}>×</button><p className="eyebrow">节点流量额度</p><h2>{node.name}</h2><div className="form-grid"><Field label="总额度（GB）"><input type="number" min="0.000001" step="any" required value={limitGb} onChange={(event) => setLimitGb(event.target.value)} /></Field><Field label="每月重置日"><input type="number" min="1" max="31" required value={resetDay} onChange={(event) => setResetDay(event.target.value)} /></Field><Field label="计费方向"><select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="up">上行</option><option value="down">下行</option><option value="both">上下行合计</option></select></Field></div>{error && <Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button></div></form></div>;
}

function AdminNodes() {
  const [nodes, setNodes] = useState<Json[] | null>(null); const [token, setToken] = useState("");
  const [trafficNode, setTrafficNode] = useState<Json | null>(null);
  const [danger, setDanger] = useState<DangerAction | null>(null);
  const load = () => api<{ nodes: Json[] }>("/api/admin/nodes").then((r) => setNodes(r.nodes)); useEffect(() => { void load(); }, []);
  const rotate = (node: Json) => setDanger({ title: `轮换节点“${node.name}”的令牌`, description: "旧令牌会立即失效，节点 Agent 必须改用新令牌。", confirmLabel: "确认轮换", run: async () => { const result = await api<Json>(`/api/admin/nodes/${node.id}/rotate-token`, { method: "POST", body: "{}" }); setToken(result.token); } });
  const remove = (node: Json) => setDanger({ title: `删除节点“${node.name}”`, summary: <><strong>{node.name}</strong><span>{String(node.protocol).toUpperCase()}{node.config?.server ? ` · ${node.config.server}:${node.config.port}` : ""}</span></>, impacts: ["节点令牌将立即失效，节点会从套餐和用户授权中移除", "安装令牌及上报去重记录会一并删除", "普通删除遇到历史用量时会停止，不会破坏账务依据"], confirmLabel: "删除节点", force: { name: node.name, description: "同时删除该节点的历史用量明细，会影响后续用量与收益统计；已写入账本的记录不会自动回滚。", confirmLabel: "强制删除节点" }, run: async (force) => { await api(`/api/admin/nodes/${node.id}${force ? "?force=true" : ""}`, { method: "DELETE", body: "{}" }); await load(); } });
  if (!nodes) return <Loading />;
  return <Page title="我的节点" description="新增节点的后端、协议和配置项均由站长启用的后端仓库提供" action={<Link className="button primary" to="/admin/deploy">＋ 新增节点</Link>}>
    {token && <Notice tone="success"><strong>请立即保存节点令牌：</strong><code className="token">{token}</code><button className="link-button" onClick={() => navigator.clipboard.writeText(token)}>复制</button>。关闭后无法再次查看。</Notice>}
    <section className="panel table-wrap"><table><thead><tr><th>节点</th><th>协议</th><th>状态</th><th>在线</th><th>最后心跳</th><th></th></tr></thead><tbody>{nodes.map((node) => <tr key={node.id}><td><strong>{node.name}</strong><small className="cell-sub">{node.config.server}:{node.config.port}</small><TrafficSummary node={node} /></td><td className="upper">{node.protocol}</td><td><Badge value={node.status} /></td><td>{node.online_count}</td><td>{date(node.last_seen_at)}</td><td className="actions">{node.trafficSupported && <button type="button" className="link-button" onClick={() => setTrafficNode(node)}>流量额度</button>}<button type="button" className="link-button" onClick={() => rotate(node)}>轮换令牌</button><button type="button" className="link-button negative" onClick={() => remove(node)}>删除</button></td></tr>)}</tbody></table>{!nodes.length && <Empty>还没有节点</Empty>}</section>
    <TrafficDialog node={trafficNode} onClose={() => setTrafficNode(null)} onSaved={load} />
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function NodeDeploy({ returnTo }: { returnTo: string }) {
  const [presets, setPresets] = useState<Json[] | null>(null);
  const [backendId, setBackendId] = useState("");
  const [presetId, setPresetId] = useState("");
  const [name, setName] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [trafficLimitGb, setTrafficLimitGb] = useState("1000");
  const [trafficResetDay, setTrafficResetDay] = useState("1");
  const [trafficDirection, setTrafficDirection] = useState("both");
  const [command, setCommand] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ presets: Json[] }>("/api/deploy/presets").then((result) => { setPresets(result.presets); if (result.presets[0]) { setBackendId(result.presets[0].backend_id); setPresetId(result.presets[0].preset_id); } }).catch((reason) => { setError(reason.message); setPresets([]); }); }, []);
  const backends = Array.from(new Map((presets || []).map((preset) => [preset.backend_id, { id: preset.backend_id, name: preset.backend_name, version: preset.backend_version }])).values());
  const backendPresets = (presets || []).filter((preset) => preset.backend_id === backendId);
  const selected = backendPresets.find((preset) => preset.preset_id === presetId);
  useEffect(() => {
    if (backendPresets.length && !backendPresets.some((preset) => preset.preset_id === presetId)) setPresetId(backendPresets[0].preset_id);
  }, [backendId, presets]);
  useEffect(() => { setInputs(Object.fromEntries((selected?.inputs || []).map((field: Json) => [field.key, field.type === "checkbox" ? field.default || "false" : field.default || ""]))); setCommand(""); }, [selected?.backend_repository_id, selected?.preset_id]);
  const visibleInputs = (selected?.inputs || []).filter((field: Json) => !field.when || (inputs[field.when.key] || "") === field.when.equals);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setCommand("");
    try {
      const traffic = selected.capabilities?.includes("nodeTrafficLimit") ? { limitBytes: Math.round(Number(trafficLimitGb) * 1024 ** 3), resetDay: Number(trafficResetDay), direction: trafficDirection } : undefined;
      const created = await api<Json>("/api/deploy/nodes", { method: "POST", body: JSON.stringify({ backendId: selected.backend_id, presetId: selected.preset_id, name, inputs, traffic }) });
      const installed = await api<Json>(`/api/deploy/nodes/${created.node.id}/install-command`, { method: "POST", body: JSON.stringify({ inputs }) });
      setCommand(installed.command); setExpiresAt(installed.expiresAt);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建安装命令失败"); }
    finally { setBusy(false); }
  };
  if (!presets) return <Loading />;
  return <Page title="新增节点" description="选择后端后，配置项由该后端仓库的 README 清单提供" action={<Link className="button" to={returnTo}>返回节点列表</Link>}>
    {error && <Notice tone="danger">{error}</Notice>}
    {!presets.length ? <section className="panel"><Empty>暂无已启用后端，请联系站长先导入并确认后端仓库</Empty></section> : <div className="two-column">
      <form className="panel form-stack" onSubmit={submit}>
        <h2>后端与配置</h2>
        <Field label="节点后端"><select value={backendId} onChange={(event) => setBackendId(event.target.value)}>{backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.name} · {backend.version}</option>)}</select></Field>
        <Field label="配置方案"><select value={presetId} onChange={(event) => setPresetId(event.target.value)}>{backendPresets.map((preset) => <option key={preset.preset_id} value={preset.preset_id}>{preset.name} · {String(preset.protocol).toUpperCase()}</option>)}</select></Field>
        {selected && <Notice>{selected.description || `${selected.protocol} 节点预设`}<br />固定提交：<code>{String(selected.commit_sha).slice(0, 12)}</code>{selected.generatedOutputs.length ? `；安装时生成 ${selected.generatedOutputs.join("、")}` : ""}</Notice>}
        <Field label="节点名称"><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：香港 01" /></Field>
        {visibleInputs.map((field: Json) => field.type === "checkbox" ? <label className="check backend-toggle" key={field.key}><input type="checkbox" checked={inputs[field.key] === "true"} onChange={(event) => setInputs({ ...inputs, [field.key]: event.target.checked ? "true" : "false" })} /><span><strong>{field.label}</strong>{field.help && <small>{field.help}</small>}</span></label> : <Field key={field.key} label={field.label} hint={field.help}>{field.type === "select" ? <select required={field.required !== false} value={inputs[field.key] || ""} onChange={(event) => setInputs({ ...inputs, [field.key]: event.target.value })}><option value="" disabled>请选择</option>{field.options.map((option: Json) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input required={field.required !== false} type={field.type === "email" ? "email" : field.type === "number" ? "number" : field.type === "url" ? "url" : field.type === "password" ? "password" : "text"} maxLength={512} autoComplete={field.type === "password" ? "off" : undefined} placeholder={field.placeholder || ""} value={inputs[field.key] || ""} onChange={(event) => setInputs({ ...inputs, [field.key]: event.target.value })} />}</Field>)}
        {selected?.capabilities?.includes("nodeTrafficLimit") && <><h2>节点流量额度</h2><Field label="总额度（GB）"><input type="number" min="0.000001" step="any" required value={trafficLimitGb} onChange={(event) => setTrafficLimitGb(event.target.value)} /></Field><Field label="每月重置日"><input type="number" min="1" max="31" required value={trafficResetDay} onChange={(event) => setTrafficResetDay(event.target.value)} /></Field><Field label="计费方向"><select value={trafficDirection} onChange={(event) => setTrafficDirection(event.target.value)}><option value="up">上行</option><option value="down">下行</option><option value="both">上下行合计</option></select></Field></>}
        <button className="button primary" disabled={busy}>{busy ? "正在生成…" : "创建节点并生成安装命令"}</button>
      </form>
      <section className="panel command-panel">
        <h2>服务器安装命令</h2>
        {command ? <><Notice tone="success">命令有效至 {date(expiresAt)}，仅可使用一次。节点安装完成后仍需站长审核。</Notice><pre><code>{command}</code></pre><button className="button primary" onClick={() => navigator.clipboard.writeText(command)}>复制命令</button></> : <Empty>填写左侧配置后生成带脚本哈希校验的一次性命令</Empty>}
      </section>
    </div>}
  </Page>;
}

function AdminUsers() {
  const { siteMode } = useAuth();
  const [users, setUsers] = useState<Json[] | null>(null); const [link, setLink] = useState("");
  const load = () => api<{ users: Json[] }>("/api/admin/users").then((r) => setUsers(r.users)); useEffect(() => { void load(); }, []);
  const invite = async () => { const result = await api<Json>("/api/admin/invitations", { method: "POST", body: JSON.stringify({ expiresHours: 72 }) }); setLink(result.url); await navigator.clipboard.writeText(result.url); };
  const toggle = async (user: Json) => { await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: user.status === "active" ? "disabled" : "active" }) }); await load(); };
  if (!users) return <Loading />;
  return <Page title="邀请用户" description="用户归属关系创建后不可修改" action={<button className="button primary" onClick={invite}>生成邀请链接</button>}>
    {link && <Notice tone="success">邀请链接已复制，有效期 72 小时：<code className="token">{link}</code></Notice>}
    <section className="panel table-wrap"><table><thead><tr><th>邮箱</th><th>状态</th>{siteMode === "plan" && <th>套餐到期</th>}<th>加入时间</th><th></th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.email}</td><td><Badge value={user.status} /></td>{siteMode === "plan" && <td>{date(user.expires_at)}</td>}<td>{date(user.created_at)}</td><td><button className="link-button" onClick={() => toggle(user)}>{user.status === "active" ? "停用" : "恢复"}</button></td></tr>)}</tbody></table>{!users.length && <Empty>还没有受邀用户</Empty>}</section>
  </Page>;
}

function AdminEarnings() {
  const [data, setData] = useState<Json | null>(null); const [withdrawals, setWithdrawals] = useState<Json[]>([]); const [amount, setAmount] = useState(""); const [account, setAccount] = useState(""); const [error, setError] = useState("");
  const load = async () => { const [earn, wd] = await Promise.all([api<Json>("/api/admin/earnings"), api<Json>("/api/admin/withdrawals")]); setData(earn); setWithdrawals(wd.withdrawals); }; useEffect(() => { load(); }, []);
  const withdraw = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await api("/api/admin/withdrawals", { method: "POST", body: JSON.stringify({ amountCents: Math.round(Number(amount) * 100), alipayAccount: account }) }); setAmount(""); await load(); } catch (e) { setError(e instanceof Error ? e.message : "提交失败"); } };
  if (!data) return <Loading />;
  return <Page title="收益与提现" description="销售佣金和节点流量分成均冻结 7 天"><div className="stat-grid"><Stat label="可提现余额" value={money(data.availableCents)} hint="负余额会由未来收益抵扣" /><Stat label="账本记录" value={String(data.entries.length)} hint="所有变化不可改写" /></div><div className="two-column"><section className="panel"><h2>申请提现</h2><form className="form-stack" onSubmit={withdraw}><Field label="金额（元）"><input type="number" min="100" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field><Field label="支付宝账号"><input value={account} onChange={(e) => setAccount(e.target.value)} required /></Field>{error && <Notice tone="danger">{error}</Notice>}<button className="button primary">提交申请</button></form><div className="mini-list">{withdrawals.map((row) => <div key={row.id}><span>{date(row.created_at)}</span><strong>{money(row.amount_cents)}</strong><Badge value={row.status} /></div>)}</div></section><section className="panel table-wrap"><h2>收益账本</h2><table><thead><tr><th>类型</th><th>金额</th><th>可用时间</th></tr></thead><tbody>{data.entries.map((row: Json) => <tr key={row.id}><td>{row.kind}</td><td className={row.amount_cents < 0 ? "negative" : "positive"}>{row.amount_cents < 0 ? "−" : "+"}{money(Math.abs(row.amount_cents))}</td><td>{date(row.available_at)}</td></tr>)}</tbody></table></section></div></Page>;
}

function OwnerDashboard() {
  const { siteMode } = useAuth();
  const [data, setData] = useState<Json | null>(null); useEffect(() => { api<Json>("/api/owner/overview").then((r) => setData(r.overview)); }, []);
  if (!data) return <Loading />;
  return <Page title="全站概览" description={siteMode === "plan" ? "套餐运营、节点与交易状态" : "逐节点授权、用户与节点状态"}><div className={`stat-grid ${siteMode === "plan" ? "four" : ""}`}><Stat label="用户" value={String(data.users)} hint={`${data.admins} 位管理员`} /><Stat label="已审核节点" value={String(data.active_nodes)} hint={`${data.pending_nodes} 个待审核`} />{siteMode === "plan" && <><Stat label="累计实收" value={money(data.revenue_cents)} hint="仅支付宝现金部分" /><Stat label="待审提现" value={String(data.pending_withdrawals)} hint="人工转账后核销" /></>}</div><section className="panel feature-panel"><div><p className="eyebrow">{siteMode === "plan" ? "套餐运营模式" : "逐节点授权模式"}</p><h2>{siteMode === "plan" ? "套餐决定用户可用节点" : "站长直接为用户逐个分配节点"}</h2><p className="muted">站长可直接新增并维护自营节点；管理员节点仍由原管理员维护，站长负责审核与授权。</p></div><div className="quick-actions"><Link className="button primary" to="/owner/nodes">管理节点</Link><Link className="button" to={siteMode === "plan" ? "/owner/plans" : "/owner/grants"}>{siteMode === "plan" ? "编排套餐" : "分配节点"}</Link></div></section></Page>;
}

function OwnerNodes() {
  const { user } = useAuth();
  const [nodes, setNodes] = useState<Json[] | null>(null); const [token, setToken] = useState("");
  const [trafficNode, setTrafficNode] = useState<Json | null>(null);
  const [danger, setDanger] = useState<DangerAction | null>(null);
  const load = () => api<{ nodes: Json[] }>("/api/owner/nodes").then((r) => setNodes(r.nodes)); useEffect(() => { void load(); }, []);
  const action = async (id: string, value: "approve" | "suspend") => { await api(`/api/owner/nodes/${id}/action`, { method: "POST", body: JSON.stringify({ action: value }) }); await load(); };
  const rotate = (node: Json) => setDanger({ title: `轮换节点“${node.name}”的令牌`, description: "旧令牌会立即失效，节点 Agent 必须改用新令牌。", confirmLabel: "确认轮换", run: async () => { const result = await api<Json>(`/api/owner/nodes/${node.id}/rotate-token`, { method: "POST", body: "{}" }); setToken(result.token); } });
  const archive = (node: Json) => setDanger({ title: `归档节点“${node.name}”`, description: "归档后节点将停止出现在订阅和套餐可用节点中。", confirmLabel: "确认归档", run: async () => { await api(`/api/owner/nodes/${node.id}`, { method: "PATCH", body: JSON.stringify({ archive: true }) }); await load(); } });
  const remove = (node: Json) => setDanger({ title: `删除节点“${node.name}”`, summary: <><strong>{node.name}</strong><span>{String(node.protocol).toUpperCase()}{node.config?.server ? ` · ${node.config.server}:${node.config.port}` : ""}</span></>, impacts: ["节点令牌将立即失效，节点会从套餐和用户授权中移除", "安装令牌及上报去重记录会一并删除", "普通删除遇到历史用量时会停止，不会破坏账务依据"], confirmLabel: "删除节点", force: { name: node.name, description: "同时删除该节点的历史用量明细，会影响后续用量与收益统计；已写入账本的记录不会自动回滚。", confirmLabel: "强制删除节点" }, run: async (force) => { await api(`/api/owner/nodes/${node.id}${force ? "?force=true" : ""}`, { method: "DELETE", body: "{}" }); await load(); } });
  if (!nodes) return <Loading />;
  return <Page title="节点管理" description="新增节点的后端、协议和配置项均由已启用的后端仓库提供" action={<Link className="button primary" to="/owner/deploy">＋ 新增节点</Link>}>
    {token && <Notice tone="success"><strong>请立即保存节点令牌：</strong><code className="token">{token}</code><button className="link-button" onClick={() => navigator.clipboard.writeText(token)}>复制</button>。关闭后无法再次查看。</Notice>}
    <section className="panel table-wrap"><table><thead><tr><th>节点</th><th>归属</th><th>协议</th><th>地址</th><th>状态</th><th>心跳</th><th></th></tr></thead><tbody>{nodes.map((node) => { const own = node.owner_admin_id === user?.id; return <tr key={node.id}><td><strong>{node.name}</strong><TrafficSummary node={node} /></td><td>{own ? "站长自营" : node.owner_email}</td><td className="upper">{node.protocol}</td><td className="mono">{node.config.server}:{node.config.port}</td><td><Badge value={node.status} /></td><td>{date(node.last_seen_at)}</td><td className="actions">{own ? <>{node.status === "pending" && <button className="link-button positive" onClick={() => action(node.id, "approve")}>审核通过</button>}{node.trafficSupported && node.status !== "archived" && <button type="button" className="link-button" onClick={() => setTrafficNode(node)}>流量额度</button>}{node.status !== "archived" && <button type="button" className="link-button" onClick={() => rotate(node)}>轮换令牌</button>}{node.status !== "archived" && <button type="button" className="link-button negative" onClick={() => archive(node)}>归档</button>}</> : <>{node.status !== "approved" && node.status !== "archived" && <button className="link-button positive" onClick={() => action(node.id, "approve")}>审核通过</button>}{node.status === "approved" && <button className="link-button negative" onClick={() => action(node.id, "suspend")}>停用</button>}</>}<button type="button" className="link-button negative" onClick={() => remove(node)}>删除</button></td></tr>; })}</tbody></table>{!nodes.length && <Empty>暂无节点</Empty>}</section>
    <TrafficDialog node={trafficNode} onClose={() => setTrafficNode(null)} onSaved={load} />
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function OwnerPlans() {
  const [plans, setPlans] = useState<Json[] | null>(null); const [nodes, setNodes] = useState<Json[]>([]); const [show, setShow] = useState(false); const [error, setError] = useState("");
  const [danger, setDanger] = useState<DangerAction | null>(null);
  const emptyPlan = { id: "", name: "", description: "", price: "", durationDays: 30, quotaGb: 100, nodePoolPercent: 0, status: "active", nodeMultipliers: {} as Record<string, number> };
  const [form, setForm] = useState<Json>(emptyPlan);
  const load = async () => { const [p, n] = await Promise.all([api<Json>("/api/owner/plans"), api<Json>("/api/owner/nodes")]); setPlans(p.plans); setNodes(n.nodes.filter((node: Json) => node.status === "approved")); }; useEffect(() => { load(); }, []);
  const openPlan = (plan?: Json) => { setError(""); setForm(plan ? { id: plan.id, name: plan.name, description: plan.description, price: plan.price_cents / 100, durationDays: plan.duration_days, quotaGb: plan.quota_bytes / 1024 ** 3, nodePoolPercent: plan.node_pool_bps / 100, status: plan.status, nodeMultipliers: Object.fromEntries(plan.nodes.map((item: Json) => [item.nodeId, item.multiplier])) } : { ...emptyPlan, nodeMultipliers: {} }); setShow(true); };
  const save = async (event: FormEvent) => { event.preventDefault(); setError(""); try { const payload = { name: form.name, description: form.description, priceCents: Math.round(Number(form.price) * 100), durationDays: Number(form.durationDays), quotaBytes: Math.round(Number(form.quotaGb) * 1024 ** 3), nodePoolBps: Math.round(Number(form.nodePoolPercent) * 100), status: form.status, nodes: Object.entries(form.nodeMultipliers).map(([nodeId, multiplier]) => ({ nodeId, multiplier: Number(multiplier) })) }; await api(form.id ? `/api/owner/plans/${form.id}` : "/api/owner/plans", { method: form.id ? "PATCH" : "POST", body: JSON.stringify(payload) }); setShow(false); await load(); } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } };
  const remove = (plan: Json) => setDanger({ title: `删除套餐“${plan.name}”`, summary: <><strong>{plan.name}</strong><span>{money(plan.price_cents)} · {plan.duration_days} 天 · {bytes(plan.quota_bytes)}</span></>, impacts: ["普通删除遇到订单或权益历史时会停止", "删除后套餐将立即从购买和管理页面移除", "强制删除会立即撤销仍在生效或等待生效的权益，且不会退款"], confirmLabel: "删除套餐", force: { name: plan.name, description: "彻底删除关联订单、权益、用量、钱包账本、收益账本和支付事件；用户钱包与管理员收益余额会随账本变化。", confirmLabel: "强制删除套餐" }, run: async (force) => { await api(`/api/owner/plans/${plan.id}${force ? "?force=true" : ""}`, { method: "DELETE", body: "{}" }); await load(); } });
  if (!plans) return <Loading />;
  return <Page title="套餐编排" description="配置套餐包含的节点及各节点流量倍率" action={<button className="button primary" onClick={() => openPlan()}>＋ 新建套餐</button>}>
    {error && !show && <Notice tone="danger">{error}</Notice>}
    <div className="card-grid plans compact">{plans.map((plan) => <article className="plan-card" key={plan.id}><div className="row-between"><Badge value={plan.status} /><span>{plan.nodeIds.length} 节点</span></div><h2>{plan.name}</h2><div className="price"><span>¥</span>{(plan.price_cents / 100).toFixed(2)}<small> / {plan.duration_days} 天</small></div><ul><li>{bytes(plan.quota_bytes)} / 自然月</li><li>节点收益池 {(plan.node_pool_bps / 100).toFixed(2)}%</li>{plan.nodes.map((item: Json) => <li key={item.nodeId}>{nodes.find((node) => node.id === item.nodeId)?.name || item.nodeId} · {item.multiplier}x</li>)}</ul><div className="quick-actions"><button className="button" onClick={() => openPlan(plan)}>编辑配置</button><button type="button" className="button" onClick={() => remove(plan)}>删除套餐</button></div></article>)}</div>
    {!plans.length && <Empty>暂无套餐</Empty>}
    {show && <div className="modal-layer"><form className="modal" onSubmit={save}><button type="button" className="modal-close" onClick={() => setShow(false)}>×</button><p className="eyebrow">套餐配置</p><h2>{form.id ? "编辑套餐" : "新建套餐"}</h2><div className="form-grid"><Field label="套餐名称"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="价格（元）"><input type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field><Field label="有效期（天）"><input type="number" min="1" required value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} /></Field><Field label="每月流量（GB）"><input type="number" min="1" required value={form.quotaGb} onChange={(e) => setForm({ ...form, quotaGb: e.target.value })} /></Field><Field label="节点收益池（%）"><input type="number" min="0" max="100" step="0.01" value={form.nodePoolPercent} onChange={(e) => setForm({ ...form, nodePoolPercent: e.target.value })} /></Field><Field label="说明"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>{form.id && <Field label="状态"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">启用</option><option value="archived">归档</option></select></Field>}</div><fieldset className="node-picker"><legend>选择节点及流量倍率</legend>{nodes.map((node) => { const selected = form.nodeMultipliers[node.id] !== undefined; return <label key={node.id}><input type="checkbox" checked={selected} onChange={(e) => { const next = { ...form.nodeMultipliers }; if (e.target.checked) next[node.id] = 1; else delete next[node.id]; setForm({ ...form, nodeMultipliers: next }); }} /> <span>{node.name}<small className="cell-sub">{node.protocol} · {node.owner_email}</small></span>{selected ? <input className="multiplier-input" aria-label={`${node.name} 倍率`} type="number" min="0.01" max="100" step="0.01" value={form.nodeMultipliers[node.id]} onChange={(e) => setForm({ ...form, nodeMultipliers: { ...form.nodeMultipliers, [node.id]: e.target.value } })} /> : <small>未加入</small>}</label>; })}</fieldset>{error && <Notice tone="danger">{error}</Notice>}<div className="modal-actions"><button type="button" className="button" onClick={() => setShow(false)}>取消</button><button className="button primary">保存套餐</button></div></form></div>}
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function OwnerUsers() {
  const { siteMode } = useAuth();
  const [users, setUsers] = useState<Json[] | null>(null); const [link, setLink] = useState(""); const [planUser, setPlanUser] = useState<Json | null>(null); const [entitlements, setEntitlements] = useState<Json[] | null>(null); const [error, setError] = useState("");
  const [danger, setDanger] = useState<DangerAction | null>(null);
  const load = async () => { const result = await api<{ users: Json[] }>("/api/owner/users"); setUsers(result.users); }; useEffect(() => { void load(); }, []);
  const invite = async () => { const result = await api<Json>("/api/owner/invitations", { method: "POST", body: JSON.stringify({ expiresHours: 72 }) }); setLink(result.url); await navigator.clipboard.writeText(result.url); };
  const commission = async (user: Json) => { const value = prompt("输入销售佣金百分比（0-100）", String((user.commission_bps || 0) / 100)); if (value === null) return; await api(`/api/owner/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ commissionBps: Math.round(Number(value) * 100) }) }); await load(); };
  const balance = async (user: Json) => { const value = prompt("设置用户钱包余额（元）", String(Number(user.wallet_cents || 0) / 100)); if (value === null) return; const cents = Math.round(Number(value) * 100); if (!Number.isFinite(cents) || cents < 0) return alert("请输入有效的非负金额"); await api(`/api/owner/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ walletCents: cents }) }); await load(); };
  const toggle = async (user: Json) => { await api(`/api/owner/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: user.status === "active" ? "disabled" : "active" }) }); await load(); };
  const managePlans = async (user: Json) => { setPlanUser(user); setEntitlements(null); setError(""); try { const result = await api<Json>(`/api/owner/users/${user.id}/entitlements`); setEntitlements(result.entitlements); } catch (reason) { setError(reason instanceof Error ? reason.message : "读取套餐失败"); setEntitlements([]); } };
  const cancelPlan = (entitlement: Json) => { if (!planUser) return; const target = planUser; setDanger({ title: `取消“${target.email}”的套餐`, description: `“${entitlement.planName}”将立即失效，待生效套餐也会被撤销，系统不会自动退款。`, confirmLabel: "确认取消套餐", run: async () => { await api(`/api/owner/users/${target.id}/entitlements/${entitlement.id}/cancel`, { method: "POST", body: "{}" }); const result = await api<Json>(`/api/owner/users/${target.id}/entitlements`); setEntitlements(result.entitlements); } }); };
  if (!users) return <Loading />;
  return <Page title="账号管理" description="管理账号状态与基础财务信息；节点权限在专用页面配置" action={<button className="button primary" onClick={invite}>邀请管理员</button>}>
    {link && <Notice tone="success">管理员邀请链接已复制：<code className="token">{link}</code></Notice>}
    <section className="panel table-wrap"><table><thead><tr><th>邮箱</th><th>角色</th><th>归属管理员</th><th>余额</th><th>状态</th><th>加入时间</th><th></th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.email}</td><td>{user.roles.join(" / ")}</td><td>{user.inviter_email || "—"}</td><td>{money(user.wallet_cents)}</td><td><Badge value={user.status} /></td><td>{date(user.created_at)}</td><td className="actions">{siteMode === "plan" && user.roles.includes("admin") && <button className="link-button" onClick={() => commission(user)}>佣金比例</button>}{siteMode === "plan" && user.roles.includes("user") && <button className="link-button" onClick={() => managePlans(user)}>套餐管理</button>}<button className="link-button" onClick={() => balance(user)}>修改余额</button><button className="link-button" onClick={() => toggle(user)}>{user.status === "active" ? "停用" : "恢复"}</button></td></tr>)}</tbody></table></section>
    {planUser && <div className="modal-layer"><section className="modal"><button type="button" className="modal-close" onClick={() => setPlanUser(null)}>×</button><p className="eyebrow">账号套餐</p><h2>{planUser.email}</h2><p className="muted">取消后权益立即失效，待生效套餐也会被撤销；系统不会自动退款。</p>{error && <Notice tone="danger">{error}</Notice>}{entitlements === null ? <Loading /> : entitlements.length ? <div className="form-stack">{entitlements.map((entitlement) => <section className="panel" key={entitlement.id}><div className="row-between"><div><strong>{entitlement.planName}</strong><small className="cell-sub">{entitlement.status === "queued" ? "待生效" : "当前生效"} · {date(entitlement.startsAt)} 至 {date(entitlement.endsAt)}</small><small className="cell-sub">额度 {bytes(entitlement.quotaBytes)} · 订单 {entitlement.orderId}</small></div><button className="button" onClick={() => cancelPlan(entitlement)}>取消套餐</button></div></section>)}</div> : <Empty>该账号没有当前或待生效套餐</Empty>}<div className="modal-actions"><button className="button" onClick={() => setPlanUser(null)}>关闭</button></div></section></div>}
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function OwnerGrants() {
  const [users, setUsers] = useState<Json[] | null>(null); const [nodes, setNodes] = useState<Json[]>([]); const [userId, setUserId] = useState(""); const [grants, setGrants] = useState<Record<string, Json>>({}); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  useEffect(() => { Promise.all([api<Json>("/api/owner/users"), api<Json>("/api/owner/nodes")]).then(([u, n]) => { const eligible = u.users.filter((user: Json) => user.roles.includes("user")); setUsers(eligible); setNodes(n.nodes.filter((node: Json) => node.status === "approved")); if (eligible[0]) setUserId(eligible[0].id); }); }, []);
  useEffect(() => { if (!userId) { setGrants({}); return; } api<Json>(`/api/owner/users/${userId}/node-grants`).then((result) => setGrants(Object.fromEntries(result.grants.map((grant: Json) => [grant.nodeId, { ...grant, expiresAtInput: datetimeInput(grant.expiresAt), quotaGb: grant.quotaBytes ? grant.quotaBytes / 1024 ** 3 : "" }])))).catch((reason) => setError(reason.message)); }, [userId]);
  const toggleNode = (nodeId: string, checked: boolean) => { const next = { ...grants }; if (checked) next[nodeId] = { nodeId, multiplier: 1, expiresAtInput: "", quotaGb: "", quotaCycle: "monthly", usedBytes: 0, active: true }; else delete next[nodeId]; setGrants(next); };
  const updateGrant = (nodeId: string, patch: Json) => setGrants({ ...grants, [nodeId]: { ...grants[nodeId], ...patch } });
  const save = async () => { setBusy(true); setError(""); setNotice(""); try { await api(`/api/owner/users/${userId}/node-grants`, { method: "PUT", body: JSON.stringify({ grants: Object.values(grants).map((grant: Json) => ({ nodeId: grant.nodeId, multiplier: Number(grant.multiplier), expiresAt: grant.expiresAtInput ? Math.floor(new Date(grant.expiresAtInput).getTime() / 1000) : null, quotaBytes: grant.quotaGb === "" ? null : Math.round(Number(grant.quotaGb) * 1024 ** 3), quotaCycle: grant.quotaGb === "" ? null : grant.quotaCycle })) }) }); setNotice("节点授权已保存"); const result = await api<Json>(`/api/owner/users/${userId}/node-grants`); setGrants(Object.fromEntries(result.grants.map((grant: Json) => [grant.nodeId, { ...grant, expiresAtInput: datetimeInput(grant.expiresAt), quotaGb: grant.quotaBytes ? grant.quotaBytes / 1024 ** 3 : "" }]))); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); } finally { setBusy(false); } };
  if (!users) return <Loading />;
  return <Page title="节点授权" description="逐个用户、逐个节点配置独立期限、额度周期和流量倍率" action={<button className="button primary" disabled={!userId || busy} onClick={save}>{busy ? "保存中…" : "保存授权"}</button>}>
    {notice && <Notice tone="success">{notice}</Notice>}{error && <Notice tone="danger">{error}</Notice>}
    <section className="panel"><Field label="选择用户"><select value={userId} onChange={(event) => { setNotice(""); setError(""); setUserId(event.target.value); }}><option value="" disabled>请选择用户</option>{users.map((user) => <option key={user.id} value={user.id}>{user.email} · {user.status === "active" ? "正常" : "已停用"}</option>)}</select></Field></section>
    <div className="grant-editor">{nodes.map((node) => { const grant = grants[node.id]; return <article className={`panel grant-editor-card ${grant ? "selected" : ""}`} key={node.id}><label className="grant-heading"><input type="checkbox" checked={Boolean(grant)} onChange={(event) => toggleNode(node.id, event.target.checked)} /><span><strong>{node.name}</strong><small>{String(node.protocol).toUpperCase()} · {node.owner_email}</small></span>{grant && <Badge value={grant.active === false ? "expired" : "active"} />}</label>{grant && <div className="form-grid grant-fields"><Field label="流量倍率"><input type="number" min="0.01" max="100" step="0.01" value={grant.multiplier} onChange={(event) => updateGrant(node.id, { multiplier: event.target.value })} /></Field><Field label="到期时间" hint="留空表示不限期"><input type="datetime-local" value={grant.expiresAtInput} onChange={(event) => updateGrant(node.id, { expiresAtInput: event.target.value })} /></Field><Field label="流量额度（GB）" hint="留空表示不限量"><input type="number" min="0.01" step="0.01" value={grant.quotaGb} onChange={(event) => updateGrant(node.id, { quotaGb: event.target.value })} /></Field><Field label="额度周期"><select disabled={grant.quotaGb === ""} value={grant.quotaCycle || "monthly"} onChange={(event) => updateGrant(node.id, { quotaCycle: event.target.value })}><option value="monthly">每自然月重置</option><option value="total">整个授权期累计</option></select></Field></div>}{grant?.quotaBytes && <p className="muted">当前周期已计费 {bytes(grant.usedBytes)} / {bytes(grant.quotaBytes)}</p>}</article>; })}</div>
    {!users.length && <section className="panel"><Empty>暂无普通用户</Empty></section>}{!nodes.length && <section className="panel"><Empty>暂无已审核节点</Empty></section>}
  </Page>;
}

function OwnerSettings() {
  const { refresh } = useAuth(); const navigate = useNavigate();
  const [data, setData] = useState<Json | null>(null); const [danger, setDanger] = useState<DangerAction | null>(null);
  const load = () => api<Json>("/api/owner/settings/site-mode").then(setData); useEffect(() => { void load(); }, []);
  const switchMode = (next: SiteMode) => { if (!data || next === data.mode) return; const name = next === "plan" ? "套餐运营模式" : "逐节点授权模式"; setDanger({ title: `切换为“${name}”`, description: "切换不会转换或删除历史数据，但整站的购买、授权和管理入口会立即改变。", confirmLabel: "确认切换模式", run: async () => { await api("/api/owner/settings/site-mode", { method: "PUT", body: JSON.stringify({ mode: next }) }); await refresh(); navigate(next === "plan" ? "/owner/plans" : "/owner/grants"); } }); };
  if (!data) return <Loading />;
  const blockerTotal = Object.values(data.blockers || {}).reduce((sum: number, value: any) => sum + Number(value), 0);
  return <Page title="系统设置" description="站点模式决定整站的用户界面、商业功能和节点授权链路">
    {blockerTotal > 0 && <Notice tone="danger">当前仍有未结业务，暂时不能切换：{data.blockers.entitlements ? `有效或未来套餐 ${data.blockers.entitlements} 个；` : ""}{data.blockers.orders ? `待处理订单 ${data.blockers.orders} 个；` : ""}{data.blockers.withdrawals ? `待处理提现 ${data.blockers.withdrawals} 个；` : ""}{data.blockers.grants ? `有效节点授权 ${data.blockers.grants} 个；` : ""}</Notice>}
    <div className="mode-cards"><article className={`panel mode-card ${data.mode === "plan" ? "selected" : ""}`}><p className="eyebrow">套餐运营</p><h2>套餐运营模式</h2><p className="muted">用户购买套餐；套餐决定期限、流量和可用节点。启用支付、订单、佣金与提现。</p><button className={`button ${data.mode === "plan" ? "primary" : ""}`} disabled={data.mode === "plan" || blockerTotal > 0} onClick={() => switchMode("plan")}>{data.mode === "plan" ? "当前模式" : "切换到套餐模式"}</button></article><article className={`panel mode-card ${data.mode === "direct" ? "selected" : ""}`}><p className="eyebrow">逐节点授权</p><h2>逐节点授权模式</h2><p className="muted">站长为用户逐个分配节点，每个授权独立设置期限、额度周期和倍率，不需要套餐。</p><button className={`button ${data.mode === "direct" ? "primary" : ""}`} disabled={data.mode === "direct" || blockerTotal > 0} onClick={() => switchMode("direct")}>{data.mode === "direct" ? "当前模式" : "切换到逐节点模式"}</button></article></div>
    <DangerDialog action={danger} onClose={() => setDanger(null)} />
  </Page>;
}

function OwnerPayments() {
  const [data, setData] = useState<Json | null>(null);
  const [form, setForm] = useState<Json>({ displayName: "支付宝", enabled: false, gateway: "https://openapi.alipay.com/gateway.do", appId: "", privateKey: "", publicKey: "" });
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const load = async () => {
    const result = await api<Json>("/api/owner/payment-methods");
    setData(result);
    const method = result.methods.find((item: Json) => item.provider === "alipay");
    if (method) setForm((current: Json) => ({ ...current, displayName: method.displayName, enabled: method.enabled, gateway: method.gateway, appId: method.appId }));
  };
  useEffect(() => { void load().catch((reason) => setError(reason.message)); }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await api("/api/owner/payment-methods/alipay", { method: "PUT", body: JSON.stringify(form) });
      setNotice("支付宝支付配置已保存；新订单会使用这组配置。");
      setForm((current: Json) => ({ ...current, privateKey: "", publicKey: "" }));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };
  if (!data && !error) return <Loading />;
  const method = data?.methods.find((item: Json) => item.provider === "alipay");
  return <Page title="支付对接" description="由站长统一维护支付渠道；私钥加密保存且不会回显">
    {notice && <Notice tone="success">{notice}</Notice>}{error && <Notice tone="danger">{error}</Notice>}
    <div className="two-column">
      <form className="panel form-stack" onSubmit={save}>
        <div className="row-between"><h2>支付宝当面付</h2><Badge value={form.enabled ? "enabled" : "disabled"} /></div>
        {method?.source === "environment" && <Notice>当前读取部署环境变量；保存后将改用站长后台配置。</Notice>}
        <Field label="显示名称"><input required maxLength={40} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></Field>
        <Field label="支付宝网关"><input type="url" required value={form.gateway} onChange={(event) => setForm({ ...form, gateway: event.target.value })} /></Field>
        <Field label="应用 ID"><input value={form.appId} onChange={(event) => setForm({ ...form, appId: event.target.value })} placeholder="支付宝开放平台 App ID" /></Field>
        <Field label="应用私钥" hint={method?.hasCredentials ? "留空则保留已经保存的私钥" : "PKCS#8 PEM 格式"}><textarea rows={6} value={form.privateKey} onChange={(event) => setForm({ ...form, privateKey: event.target.value })} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
        <Field label="支付宝公钥" hint={method?.hasCredentials ? "留空则保留已经保存的公钥" : "PEM 格式"}><textarea rows={6} value={form.publicKey} onChange={(event) => setForm({ ...form, publicKey: event.target.value })} placeholder="-----BEGIN PUBLIC KEY-----" /></Field>
        <label className="check"><input type="checkbox" checked={Boolean(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 启用此支付方式</label>
        <button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存支付配置"}</button>
      </form>
      <section className="panel table-wrap"><h2>可对接渠道</h2><table><thead><tr><th>渠道</th><th>能力</th><th>状态</th></tr></thead><tbody>{data?.supportedProviders.map((provider: Json) => <tr key={provider.id}><td><strong>{provider.name}</strong><small className="cell-sub">{provider.id}</small></td><td>扫码下单、异步通知、主动查单</td><td><Badge value={method?.enabled ? "enabled" : "disabled"} /></td></tr>)}</tbody></table><p className="muted payment-help">支付渠道采用适配器结构；新增微信支付、Stripe 等渠道时需实现各自的签名、下单、回调和查单逻辑，再在此页面开放配置。</p></section>
    </div>
  </Page>;
}

function OwnerOrders() {
  const [rows, setRows] = useState<Json[] | null>(null); useEffect(() => { api<Json>("/api/owner/orders").then((r) => setRows(r.orders)); }, []); if (!rows) return <Loading />;
  return <Page title="全站订单" description="首版不提供线上退款"><section className="panel table-wrap"><table><thead><tr><th>用户</th><th>套餐</th><th>订单</th><th>实收</th><th>钱包</th><th>状态</th><th>时间</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.email}</td><td>{row.plan_name}</td><td className="mono">{row.id.slice(-10)}</td><td>{money(row.cash_cents)}</td><td>{money(row.wallet_cents)}</td><td><Badge value={row.status} /></td><td>{date(row.created_at)}</td></tr>)}</tbody></table>{!rows.length && <Empty>暂无订单</Empty>}</section></Page>;
}

function OwnerWithdrawals() {
  const [rows, setRows] = useState<Json[] | null>(null); const [danger, setDanger] = useState<DangerAction | null>(null); const load = () => api<Json>("/api/owner/withdrawals").then((r) => setRows(r.withdrawals)); useEffect(() => { void load(); }, []);
  const pay = async (row: Json) => { const reference = prompt(`确认已向 ${row.alipay_account} 转账 ${money(row.amount_cents)}，请输入支付宝流水号：`); if (!reference) return; await api(`/api/owner/withdrawals/${row.id}/action`, { method: "POST", body: JSON.stringify({ action: "paid", transferReference: reference }) }); await load(); };
  const reject = (row: Json) => setDanger({ title: `驳回 ${row.email} 的提现申请`, description: `驳回后 ${money(row.amount_cents)} 会退回管理员可提现余额。`, confirmLabel: "确认驳回", run: async () => { await api(`/api/owner/withdrawals/${row.id}/action`, { method: "POST", body: JSON.stringify({ action: "reject" }) }); await load(); } });
  if (!rows) return <Loading />;
  return <Page title="提现审核" description="完成线下支付宝转账后填写真实流水号核销"><section className="panel table-wrap"><table><thead><tr><th>管理员</th><th>支付宝账号</th><th>金额</th><th>状态</th><th>申请时间</th><th>流水号</th><th></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.email}</td><td>{row.alipay_account}</td><td><strong>{money(row.amount_cents)}</strong></td><td><Badge value={row.status} /></td><td>{date(row.created_at)}</td><td className="mono">{row.transfer_reference || "—"}</td><td className="actions">{row.status === "pending" && <><button className="link-button positive" onClick={() => pay(row)}>已转账</button><button type="button" className="link-button negative" onClick={() => reject(row)}>驳回</button></>}</td></tr>)}</tbody></table>{!rows.length && <Empty>暂无提现申请</Empty>}</section><DangerDialog action={danger} onClose={() => setDanger(null)} /></Page>;
}

function OwnerBackends() {
  const [backends, setBackends] = useState<Json[] | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [ref, setRef] = useState("");
  const [readmePath, setReadmePath] = useState("README.md");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api<{ backends: Json[] }>("/api/owner/backends").then((result) => setBackends(result.backends));
  useEffect(() => { void load(); }, []);
  const importRepository = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<Json>("/api/owner/backends/import", { method: "POST", body: JSON.stringify({ repositoryUrl, ref, readmePath }) });
      setNotice(`已校验 ${result.preview.commitSha.slice(0, 12)} 和 ${result.preview.presets.length} 个预设，请确认后启用。`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败"); }
    finally { setBusy(false); }
  };
  const confirmBackend = async (id: string) => { setError(""); try { await api(`/api/owner/backends/${id}/confirm`, { method: "POST", body: "{}" }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "确认失败"); } };
  const syncBackend = async (row: Json) => { const nextRef = prompt("输入要同步的分支、标签或提交 SHA", row.requested_ref); if (nextRef === null || !nextRef.trim()) return; setError(""); try { const result = await api<Json>(`/api/owner/backends/${row.id}/sync`, { method: "POST", body: JSON.stringify({ ref: nextRef.trim() }) }); setNotice(result.diff.changed ? "检测到新提交，请检查后重新确认。" : "内容已重新校验，请重新确认。 "); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "同步失败"); } };
  const toggleBackend = async (row: Json) => { setError(""); try { await api(`/api/owner/backends/${row.id}`, { method: "PATCH", body: JSON.stringify({ enabled: row.status !== "enabled" }) }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); } };
  if (!backends) return <Loading />;
  return <Page title="后端仓库" description="从公开 GitHub 仓库读取固定提交的 README、校验特征码、预设和安装脚本">
    {notice && <Notice tone="success">{notice}</Notice>}{error && <Notice tone="danger">{error}</Notice>}
    <div className="two-column backend-layout">
      <form className="panel form-stack" onSubmit={importRepository}>
        <h2>导入兼容后端</h2>
        <Field label="GitHub 仓库"><input type="url" required value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/backend" /></Field>
        <Field label="分支、标签或提交 SHA" hint="留空时读取仓库默认分支，但保存时会固定为提交 SHA"><input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="v1.0.0" /></Field>
        <Field label="README 路径"><input required value={readmePath} onChange={(event) => setReadmePath(event.target.value)} /></Field>
        <button className="button primary" disabled={busy}>{busy ? "读取并校验…" : "导入并生成预览"}</button>
      </form>
      <section className="panel table-wrap"><h2>已导入后端</h2><table><thead><tr><th>后端</th><th>仓库 / 提交</th><th>预设</th><th>状态</th><th></th></tr></thead><tbody>{backends.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><small className="cell-sub">{row.backend_id} · {row.version}</small></td><td><a href={row.repository_url} target="_blank" rel="noreferrer">{row.repository_owner}/{row.repository_name}</a><small className="cell-sub mono">{String(row.commit_sha).slice(0, 12)}</small></td><td>{row.preset_count}</td><td><Badge value={row.status} /></td><td className="actions">{row.status === "pending" ? <button className="link-button positive" onClick={() => confirmBackend(row.id)}>确认启用</button> : <button className={`link-button ${row.status === "enabled" ? "negative" : "positive"}`} onClick={() => toggleBackend(row)}>{row.status === "enabled" ? "停用" : "启用"}</button>}<button className="link-button" onClick={() => syncBackend(row)}>重新同步</button></td></tr>)}</tbody></table>{!backends.length && <Empty>尚未导入后端仓库</Empty>}</section>
    </div>
  </Page>;
}

function OwnerAudit() {
  const [rows, setRows] = useState<Json[] | null>(null); useEffect(() => { api<Json>("/api/owner/audit").then((r) => setRows(r.logs)); }, []); if (!rows) return <Loading />;
  return <Page title="审计日志" description="角色、节点、支付、账本和提现操作记录"><section className="panel table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{date(row.created_at)}</td><td>{row.actor_email || "系统"}</td><td className="mono">{row.action}</td><td>{row.subject_type} · {row.subject_id?.slice(-8) || "—"}</td><td><code>{row.metadata_json === "{}" ? "—" : row.metadata_json}</code></td></tr>)}</tbody></table></section></Page>;
}

function UserArea({ children }: { children: ReactNode }) { return <Protected><Shell mode="user">{children}</Shell></Protected>; }
function AdminArea({ children }: { children: ReactNode }) { return <Protected role="admin"><Shell mode="admin">{children}</Shell></Protected>; }
function OwnerArea({ children }: { children: ReactNode }) { return <Protected role="owner"><Shell mode="owner">{children}</Shell></Protected>; }

function NotFound() { return <main className="not-found"><div className="brand brand-large"><span>B</span> BoardLess</div><h1>页面不存在</h1><p>你访问的地址无效或已被移动。</p><Link className="button primary" to="/">返回控制台</Link></main>; }

function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading full />;
  return <Routes>
    <Route path="/" element={<Navigate to={user ? "/app" : "/login"} replace />} />
    <Route path="/login" element={<Login />} /><Route path="/admin/login" element={<Login admin />} /><Route path="/invite/:token" element={<Invite />} />
    <Route path="/app" element={<UserArea><UserDashboard /></UserArea>} /><Route path="/app/plans" element={<ModeOnly siteMode="plan"><UserArea><Plans /></UserArea></ModeOnly>} /><Route path="/app/subscription" element={<UserArea><Subscription /></UserArea>} /><Route path="/app/usage" element={<UserArea><Usage /></UserArea>} /><Route path="/app/orders" element={<UserArea><Orders /></UserArea>} />
    <Route path="/admin" element={<AdminArea><AdminDashboard /></AdminArea>} /><Route path="/admin/nodes" element={<AdminArea><AdminNodes /></AdminArea>} /><Route path="/admin/deploy" element={<AdminArea><NodeDeploy returnTo="/admin/nodes" /></AdminArea>} /><Route path="/admin/users" element={<AdminArea><AdminUsers /></AdminArea>} /><Route path="/admin/earnings" element={<ModeOnly siteMode="plan"><AdminArea><AdminEarnings /></AdminArea></ModeOnly>} />
    <Route path="/owner" element={<OwnerArea><OwnerDashboard /></OwnerArea>} /><Route path="/owner/nodes" element={<OwnerArea><OwnerNodes /></OwnerArea>} /><Route path="/owner/deploy" element={<OwnerArea><NodeDeploy returnTo="/owner/nodes" /></OwnerArea>} /><Route path="/owner/backends" element={<OwnerArea><OwnerBackends /></OwnerArea>} /><Route path="/owner/plans" element={<ModeOnly siteMode="plan"><OwnerArea><OwnerPlans /></OwnerArea></ModeOnly>} /><Route path="/owner/grants" element={<ModeOnly siteMode="direct"><OwnerArea><OwnerGrants /></OwnerArea></ModeOnly>} /><Route path="/owner/users" element={<OwnerArea><OwnerUsers /></OwnerArea>} /><Route path="/owner/payments" element={<ModeOnly siteMode="plan"><OwnerArea><OwnerPayments /></OwnerArea></ModeOnly>} /><Route path="/owner/orders" element={<ModeOnly siteMode="plan"><OwnerArea><OwnerOrders /></OwnerArea></ModeOnly>} /><Route path="/owner/withdrawals" element={<ModeOnly siteMode="plan"><OwnerArea><OwnerWithdrawals /></OwnerArea></ModeOnly>} /><Route path="/owner/audit" element={<OwnerArea><OwnerAudit /></OwnerArea>} /><Route path="/owner/settings" element={<OwnerArea><OwnerSettings /></OwnerArea>} />
    <Route path="*" element={<NotFound />} />
  </Routes>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter></React.StrictMode>);
