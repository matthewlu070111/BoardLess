ALTER TABLE user_nodes ADD COLUMN grant_key TEXT;
ALTER TABLE direct_usage_entries ADD COLUMN grant_key TEXT;

UPDATE user_nodes
SET grant_key = user_id || ':' || node_id || ':' || created_at
WHERE grant_key IS NULL;

UPDATE direct_usage_entries
SET grant_key = (
  SELECT un.grant_key FROM user_nodes un
  WHERE un.user_id = direct_usage_entries.user_id AND un.node_id = direct_usage_entries.node_id
)
WHERE grant_key IS NULL;

CREATE INDEX idx_direct_usage_grant ON direct_usage_entries(grant_key, observed_at);
