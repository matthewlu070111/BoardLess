ALTER TABLE plan_nodes ADD COLUMN multiplier_bps INTEGER NOT NULL DEFAULT 10000 CHECK (multiplier_bps BETWEEN 1 AND 1000000);

CREATE TABLE user_nodes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  multiplier_bps INTEGER NOT NULL DEFAULT 10000 CHECK (multiplier_bps BETWEEN 1 AND 1000000),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (user_id, node_id)
);

CREATE INDEX idx_user_nodes_node ON user_nodes(node_id);
