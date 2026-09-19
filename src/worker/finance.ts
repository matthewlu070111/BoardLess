import { audit, newId, now } from "./db";
import type { Env } from "./types";

interface EntitlementRow {
  id: string; user_id: string; order_id: string; starts_at: number; ends_at: number; original_seconds: number;
  price_cents: number; node_pool_bps: number; status: "active" | "closed" | "expired";
}

export function proratedCredit(priceCents: number, startsAt: number, endsAt: number, at: number): number {
  if (at >= endsAt) return 0;
  const total = Math.max(1, endsAt - startsAt);
  const remaining = Math.max(0, endsAt - Math.max(startsAt, at));
  return Math.floor(priceCents * remaining / total);
}

export async function settleNodePool(env: Env, entitlement: EntitlementRow, closedAt: number, reason: string) {
  const elapsedRatio = reason === "expired" ? 1 : Math.min(1, Math.max(0, (closedAt - entitlement.starts_at) / entitlement.original_seconds));
  const pool = Math.floor(entitlement.price_cents * entitlement.node_pool_bps / 10000 * elapsedRatio);
  if (pool <= 0) return;
  const rows = await env.DB.prepare(
    `SELECT n.owner_admin_id AS admin_id, SUM(ue.up_bytes + ue.down_bytes) AS bytes,
       MAX(CASE WHEN ap.user_id IS NULL THEN 0 ELSE 1 END) AS is_admin
     FROM usage_entries ue JOIN nodes n ON n.id = ue.node_id
     LEFT JOIN admin_profiles ap ON ap.user_id = n.owner_admin_id
     WHERE ue.entitlement_id = ? GROUP BY n.owner_admin_id`,
  ).bind(entitlement.id).all<{ admin_id: string; bytes: number; is_admin: number }>();
  const totalBytes = rows.results.reduce((sum, row) => sum + Number(row.bytes), 0);
  if (totalBytes <= 0) return;
  const availableAt = closedAt + 7 * 86400;
  const statements = rows.results.filter((row) => row.is_admin === 1).map((row) => env.DB.prepare(
    "INSERT INTO earnings_ledger (id, admin_id, order_id, entitlement_id, kind, amount_cents, available_at, metadata_json, created_at) VALUES (?, ?, ?, ?, 'node_share', ?, ?, ?, ?)",
  ).bind(newId("earn"), row.admin_id, entitlement.order_id, entitlement.id, Math.floor(pool * Number(row.bytes) / totalBytes), availableAt, JSON.stringify({ bytes: Number(row.bytes), totalBytes, pool }), now()));
  if (statements.length) await env.DB.batch(statements);
}

export async function closeEntitlement(
  env: Env,
  entitlement: EntitlementRow,
  at: number,
  reason: "upgrade" | "expired" | "owner_cancel",
  actorId: string | null = null,
) {
  if (entitlement.status !== "active") return;
  await settleNodePool(env, entitlement, at, reason);
  if (reason === "upgrade") {
    const reversal = proratedCredit(entitlement.price_cents, entitlement.starts_at, entitlement.ends_at, at);
    const commission = await env.DB.prepare(
      "SELECT admin_id, amount_cents FROM earnings_ledger WHERE entitlement_id = ? AND kind = 'sales_commission'",
    ).bind(entitlement.id).first<{ admin_id: string; amount_cents: number }>();
    if (commission && reversal > 0) {
      const ratio = reversal / Math.max(1, entitlement.price_cents);
      await env.DB.prepare(
        "INSERT INTO earnings_ledger (id, admin_id, order_id, entitlement_id, kind, amount_cents, available_at, metadata_json, created_at) VALUES (?, ?, ?, ?, 'upgrade_reversal', ?, ?, ?, ?)",
      ).bind(newId("earn"), commission.admin_id, entitlement.order_id, entitlement.id, -Math.floor(commission.amount_cents * ratio), now(), JSON.stringify({ credit_cents: reversal }), now()).run();
    }
  }
  await env.DB.prepare("UPDATE entitlements SET status = ?, closed_at = ?, close_reason = ? WHERE id = ? AND status = 'active'")
    .bind(reason === "expired" ? "expired" : "closed", at, reason, entitlement.id).run();
  await audit(env, actorId, `entitlement.${reason}`, "entitlement", entitlement.id);
}

export async function settleExpiredEntitlements(env: Env) {
  const cutoff = now();
  const rows = await env.DB.prepare("SELECT * FROM entitlements WHERE status = 'active' AND ends_at <= ? LIMIT 100")
    .bind(cutoff).all<EntitlementRow>();
  for (const row of rows.results) await closeEntitlement(env, row, row.ends_at, "expired");
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(cutoff).run();
  return rows.results.length;
}
