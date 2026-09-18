PRAGMA foreign_keys = ON;

CREATE TABLE backend_repositories (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL UNIQUE,
  repository_url TEXT NOT NULL UNIQUE,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  requested_ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  readme_path TEXT NOT NULL,
  readme_url TEXT NOT NULL,
  readme_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  panel_api_version TEXT NOT NULL,
  install_script TEXT NOT NULL,
  install_script_url TEXT NOT NULL,
  install_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enabled','disabled')),
  imported_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE backend_presets (
  backend_repository_id TEXT NOT NULL REFERENCES backend_repositories(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('shadowsocks','vmess','vless','trojan','hysteria2','tuic')),
  description TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL,
  required_inputs_json TEXT NOT NULL,
  generated_outputs_json TEXT NOT NULL,
  PRIMARY KEY (backend_repository_id, preset_id)
);

ALTER TABLE nodes ADD COLUMN backend_repository_id TEXT REFERENCES backend_repositories(id);
ALTER TABLE nodes ADD COLUMN backend_preset_id TEXT;

CREATE TABLE node_install_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  backend_repository_id TEXT NOT NULL REFERENCES backend_repositories(id),
  preset_id TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_backend_repositories_status ON backend_repositories(status, updated_at);
CREATE INDEX idx_node_install_tokens_expiry ON node_install_tokens(token_hash, expires_at, used_at);
