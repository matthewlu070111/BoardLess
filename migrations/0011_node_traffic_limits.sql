ALTER TABLE nodes ADD COLUMN traffic_limit_bytes INTEGER CHECK (traffic_limit_bytes IS NULL OR traffic_limit_bytes > 0);
ALTER TABLE nodes ADD COLUMN traffic_reset_day INTEGER CHECK (traffic_reset_day IS NULL OR traffic_reset_day BETWEEN 1 AND 31);
ALTER TABLE nodes ADD COLUMN traffic_direction TEXT CHECK (traffic_direction IS NULL OR traffic_direction IN ('up', 'down', 'both'));

CREATE INDEX idx_usage_entries_node_time ON usage_entries(node_id, observed_at);
CREATE INDEX idx_direct_usage_node_time ON direct_usage_entries(node_id, observed_at);
