CREATE TABLE direct_usage_entries (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  up_bytes INTEGER NOT NULL,
  down_bytes INTEGER NOT NULL,
  charged_up_bytes INTEGER NOT NULL,
  charged_down_bytes INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE INDEX idx_direct_usage_node ON direct_usage_entries(node_id, user_id, observed_at);
