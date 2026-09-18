PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  inviter_admin_id TEXT REFERENCES users(id),
  access_uuid TEXT NOT NULL UNIQUE,
  access_secret TEXT NOT NULL,
  subscription_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'owner')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE admin_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  alipay_account TEXT,
  disabled_at INTEGER
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  inviter_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  attempt_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  owner_admin_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('shadowsocks','vmess','vless','trojan','hysteria2','tuic')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','archived')),
  config_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at INTEGER,
  online_count INTEGER NOT NULL DEFAULT 0,
  agent_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes > 0),
  node_pool_bps INTEGER NOT NULL DEFAULT 0 CHECK (node_pool_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plan_nodes (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (plan_id, node_id)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired','cancelled','review')),
  price_cents INTEGER NOT NULL,
  wallet_cents INTEGER NOT NULL DEFAULT 0,
  cash_cents INTEGER NOT NULL DEFAULT 0,
  upgrade_credit_cents INTEGER NOT NULL DEFAULT 0,
  upgrade_from_entitlement_id TEXT,
  qr_code TEXT,
  alipay_trade_no TEXT UNIQUE,
  entitlement_id TEXT,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  original_seconds INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  quota_bytes INTEGER NOT NULL,
  node_pool_bps INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed','expired')),
  closed_at INTEGER,
  close_reason TEXT
);

CREATE TABLE quota_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  month_key TEXT NOT NULL,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month_key)
);

CREATE TABLE usage_reports (
  report_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, report_id)
);

CREATE TABLE usage_entries (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id),
  up_bytes INTEGER NOT NULL,
  down_bytes INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE earnings_ledger (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  entitlement_id TEXT REFERENCES entitlements(id),
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  alipay_account TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','rejected')),
  transfer_reference TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE payment_events (
  event_key TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_invites_inviter ON invitations(inviter_id, created_at);
CREATE INDEX idx_nodes_owner ON nodes(owner_admin_id, status);
CREATE INDEX idx_plan_nodes_node ON plan_nodes(node_id);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_orders_status ON orders(status, expires_at);
CREATE INDEX idx_entitlements_user ON entitlements(user_id, status, ends_at);
CREATE INDEX idx_usage_entries_entitlement ON usage_entries(entitlement_id, node_id);
CREATE INDEX idx_earnings_admin ON earnings_ledger(admin_id, available_at);
CREATE INDEX idx_withdrawals_status ON withdrawals(status, created_at);
