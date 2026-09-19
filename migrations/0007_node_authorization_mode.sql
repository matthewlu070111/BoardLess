CREATE TABLE system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

INSERT INTO system_settings (setting_key, setting_value, updated_at)
VALUES ('node_authorization_mode', 'plan', unixepoch());
