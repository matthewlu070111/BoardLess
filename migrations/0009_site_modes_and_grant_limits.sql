ALTER TABLE user_nodes ADD COLUMN expires_at INTEGER;
ALTER TABLE user_nodes ADD COLUMN quota_bytes INTEGER CHECK (quota_bytes IS NULL OR quota_bytes > 0);
ALTER TABLE user_nodes ADD COLUMN quota_cycle TEXT CHECK (quota_cycle IS NULL OR quota_cycle IN ('monthly', 'total'));

INSERT INTO system_settings (setting_key, setting_value, updated_at)
SELECT 'site_mode',
  CASE WHEN setting_value = 'user' THEN 'direct' ELSE 'plan' END,
  unixepoch()
FROM system_settings
WHERE setting_key = 'node_authorization_mode'
ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO system_settings (setting_key, setting_value, updated_at)
VALUES ('site_mode', 'plan', unixepoch())
ON CONFLICT(setting_key) DO NOTHING;

CREATE INDEX idx_user_nodes_expiry ON user_nodes(user_id, expires_at);
