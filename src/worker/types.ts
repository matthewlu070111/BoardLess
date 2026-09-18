export type Role = "user" | "admin" | "owner";
export type Protocol = "shadowsocks" | "vmess" | "vless" | "trojan" | "hysteria2" | "tuic";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  BOOTSTRAP_SECRET: string;
  ALIPAY_APP_ID: string;
  ALIPAY_PRIVATE_KEY: string;
  ALIPAY_PUBLIC_KEY: string;
  ALIPAY_GATEWAY: string;
}

export interface AuthUser {
  id: string;
  email: string;
  status: "active" | "disabled";
  inviterAdminId: string | null;
  accessUuid: string;
  accessSecret: string;
  subscriptionVersion: number;
  roles: Role[];
}

export interface AppVariables {
  user: AuthUser;
}

export interface NodeRow {
  id: string;
  owner_admin_id: string;
  owner_email?: string;
  name: string;
  protocol: Protocol;
  status: "pending" | "approved" | "suspended" | "archived";
  config_json: string;
  token_hash: string;
  last_seen_at: number | null;
  online_count: number;
  agent_version: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  duration_days: number;
  quota_bytes: number;
  node_pool_bps: number;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}
