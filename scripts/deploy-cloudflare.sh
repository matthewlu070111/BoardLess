#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKER_NAME="boardless"
DATABASE_NAME="boardless"
APP_ORIGIN=""
CUSTOM_DOMAIN="false"
UNATTENDED="false"
SKIP_BOOTSTRAP="false"
OWNER_EMAIL=""
OWNER_PASSWORD_FILE=""
OWNER_PASSWORD=""
ALIPAY_APP_ID=""
ALIPAY_PRIVATE_KEY_FILE=""
ALIPAY_PUBLIC_KEY_FILE=""
ALIPAY_GATEWAY="https://openapi.alipay.com/gateway.do"
ALIPAY_GATEWAY_EXPLICIT="false"
TEMP_DIR=""

usage() {
  cat <<'EOF'
BoardLess Cloudflare 一键部署脚本

交互模式：
  bash scripts/deploy-cloudflare.sh

无人值守模式：
  bash scripts/deploy-cloudflare.sh \
    --worker-name boardless \
    --database-name boardless \
    --origin https://panel.example.com \
    --custom-domain \
    --owner-email owner@example.com \
    --owner-password-file /secure/owner-password \
    --unattended

参数：
  --worker-name NAME          Worker 名称，默认 boardless
  --database-name NAME        D1 数据库名称，默认 boardless
  --origin URL                面板最终 HTTPS 地址
  --custom-domain             将 origin 的域名绑定为 Worker Custom Domain
  --owner-email EMAIL         首次创建的站长邮箱
  --owner-password-file PATH  从本地文件读取站长密码
  --skip-bootstrap            部署后不自动创建站长账号
  --alipay-app-id ID          支付宝应用 ID
  --alipay-private-key PATH   应用私钥 PEM 文件
  --alipay-public-key PATH    支付宝公钥 PEM 文件
  --alipay-sandbox            使用支付宝沙箱网关
  --unattended                无交互部署；所有必要参数必须提供
  -h, --help                  显示帮助
EOF
}

log() {
  printf '[BoardLess Cloudflare] %s\n' "$*"
}

die() {
  printf '[BoardLess Cloudflare] 错误：%s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
  unset OWNER_PASSWORD
}
trap cleanup EXIT

prompt_default() {
  local prompt="$1"
  local default_value="$2"
  local answer=""
  read -r -p "$prompt [$default_value]：" answer
  printf '%s' "${answer:-$default_value}"
}

prompt_yes_no() {
  local prompt="$1"
  local default_value="$2"
  local answer=""
  local hint="y/N"
  [[ "$default_value" == "yes" ]] && hint="Y/n"
  read -r -p "$prompt [$hint]：" answer
  answer="${answer:-$default_value}"
  [[ "$answer" =~ ^([Yy]|[Yy][Ee][Ss]|yes)$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-name)
      [[ $# -ge 2 ]] || die "--worker-name 缺少参数"
      WORKER_NAME="$2"
      shift 2
      ;;
    --database-name)
      [[ $# -ge 2 ]] || die "--database-name 缺少参数"
      DATABASE_NAME="$2"
      shift 2
      ;;
    --origin)
      [[ $# -ge 2 ]] || die "--origin 缺少参数"
      APP_ORIGIN="${2%/}"
      shift 2
      ;;
    --custom-domain)
      CUSTOM_DOMAIN="true"
      shift
      ;;
    --owner-email)
      [[ $# -ge 2 ]] || die "--owner-email 缺少参数"
      OWNER_EMAIL="$2"
      shift 2
      ;;
    --owner-password-file)
      [[ $# -ge 2 ]] || die "--owner-password-file 缺少参数"
      OWNER_PASSWORD_FILE="$2"
      shift 2
      ;;
    --skip-bootstrap)
      SKIP_BOOTSTRAP="true"
      shift
      ;;
    --alipay-app-id)
      [[ $# -ge 2 ]] || die "--alipay-app-id 缺少参数"
      ALIPAY_APP_ID="$2"
      shift 2
      ;;
    --alipay-private-key)
      [[ $# -ge 2 ]] || die "--alipay-private-key 缺少参数"
      ALIPAY_PRIVATE_KEY_FILE="$2"
      shift 2
      ;;
    --alipay-public-key)
      [[ $# -ge 2 ]] || die "--alipay-public-key 缺少参数"
      ALIPAY_PUBLIC_KEY_FILE="$2"
      shift 2
      ;;
    --alipay-sandbox)
      ALIPAY_GATEWAY="https://openapi.alipaydev.com/gateway.do"
      ALIPAY_GATEWAY_EXPLICIT="true"
      shift
      ;;
    --unattended)
      UNATTENDED="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

[[ "$(uname -s)" != "" ]] || die "无法识别操作系统"
command -v node >/dev/null 2>&1 || die "需要 Node.js 22.12 或更高版本"
command -v npm >/dev/null 2>&1 || die "需要 npm"
command -v openssl >/dev/null 2>&1 || die "需要 openssl"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' || die "需要 Node.js 22.12 或更高版本"

cd "$PROJECT_DIR"

if [[ "$ALIPAY_GATEWAY_EXPLICIT" != "true" && -f wrangler.jsonc ]]; then
  EXISTING_GATEWAY="$(node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync("wrangler.jsonc","utf8")); console.log(c.vars?.ALIPAY_GATEWAY||"")')"
  [[ -z "$EXISTING_GATEWAY" ]] || ALIPAY_GATEWAY="$EXISTING_GATEWAY"
fi

if [[ "$UNATTENDED" != "true" ]]; then
  printf '\nBoardLess Cloudflare 交互式部署\n脚本将创建或复用 D1、设置 Secrets、迁移数据库并发布 Worker。\n\n'
  WORKER_NAME="$(prompt_default "Worker 名称" "$WORKER_NAME")"
  DATABASE_NAME="$(prompt_default "D1 数据库名称" "$DATABASE_NAME")"
  if [[ -z "$APP_ORIGIN" ]]; then
    read -r -p "面板最终 HTTPS 地址（例如 https://panel.example.com）：" APP_ORIGIN
    APP_ORIGIN="${APP_ORIGIN%/}"
  fi
  if prompt_yes_no "是否把该域名配置为 Cloudflare Worker Custom Domain" "no"; then
    CUSTOM_DOMAIN="true"
  fi
  if [[ "$SKIP_BOOTSTRAP" != "true" ]]; then
    [[ -n "$OWNER_EMAIL" ]] || read -r -p "首次站长邮箱：" OWNER_EMAIL
    if [[ -z "$OWNER_PASSWORD_FILE" ]]; then
      read -r -s -p "首次站长密码（10-128 位）：" OWNER_PASSWORD
      printf '\n'
      read -r -s -p "再次输入站长密码：" OWNER_PASSWORD_CONFIRM
      printf '\n'
      [[ "$OWNER_PASSWORD" == "$OWNER_PASSWORD_CONFIRM" ]] || die "两次输入的站长密码不一致"
      unset OWNER_PASSWORD_CONFIRM
    fi
  fi
  if [[ -z "$ALIPAY_APP_ID" ]] && prompt_yes_no "现在配置支付宝当面付" "no"; then
    read -r -p "支付宝应用 ID：" ALIPAY_APP_ID
    read -r -p "应用私钥 PEM 文件路径：" ALIPAY_PRIVATE_KEY_FILE
    read -r -p "支付宝公钥 PEM 文件路径：" ALIPAY_PUBLIC_KEY_FILE
    if prompt_yes_no "是否使用支付宝沙箱网关" "yes"; then
      ALIPAY_GATEWAY="https://openapi.alipaydev.com/gateway.do"
      ALIPAY_GATEWAY_EXPLICIT="true"
    else
      ALIPAY_GATEWAY="https://openapi.alipay.com/gateway.do"
      ALIPAY_GATEWAY_EXPLICIT="true"
    fi
  fi
fi

[[ "$WORKER_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "Worker 名称格式无效"
[[ "$DATABASE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "D1 数据库名称格式无效"
[[ "$APP_ORIGIN" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?$ ]] || die "--origin 必须是没有路径的 HTTPS 地址"
if [[ "$CUSTOM_DOMAIN" == "true" ]]; then
  [[ "$APP_ORIGIN" != *:*:* && "${APP_ORIGIN#https://}" != *:* ]] || die "Cloudflare Custom Domain 不能包含端口"
fi

if [[ -n "$OWNER_PASSWORD_FILE" ]]; then
  [[ -f "$OWNER_PASSWORD_FILE" ]] || die "站长密码文件不存在：$OWNER_PASSWORD_FILE"
  OWNER_PASSWORD="$(<"$OWNER_PASSWORD_FILE")"
fi
if [[ "$UNATTENDED" == "true" && "$SKIP_BOOTSTRAP" != "true" ]]; then
  [[ -n "$OWNER_EMAIL" && -n "$OWNER_PASSWORD_FILE" ]] || die "无人值守部署需要 --owner-email 和 --owner-password-file，或使用 --skip-bootstrap"
fi
if [[ "$SKIP_BOOTSTRAP" != "true" ]]; then
  [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "站长邮箱格式无效"
  (( ${#OWNER_PASSWORD} >= 10 && ${#OWNER_PASSWORD} <= 128 )) || die "站长密码必须为 10-128 位"
  [[ "$OWNER_PASSWORD" != *$'\n'* ]] || die "站长密码不能包含换行符"
fi

if [[ -n "$ALIPAY_APP_ID" ]]; then
  [[ -f "$ALIPAY_PRIVATE_KEY_FILE" ]] || die "应用私钥文件不存在"
  [[ -f "$ALIPAY_PUBLIC_KEY_FILE" ]] || die "支付宝公钥文件不存在"
elif [[ -n "$ALIPAY_PRIVATE_KEY_FILE" || -n "$ALIPAY_PUBLIC_KEY_FILE" ]]; then
  die "支付宝配置必须同时提供应用 ID、应用私钥和支付宝公钥"
fi

log "安装项目依赖"
npm ci

if ! npx wrangler whoami >/dev/null 2>&1; then
  if [[ "$UNATTENDED" == "true" ]]; then
    die "Cloudflare 尚未认证；请配置 CLOUDFLARE_API_TOKEN 或先运行 npx wrangler login"
  fi
  log "打开 Cloudflare 登录授权"
  npx wrangler login
fi

log "更新 wrangler.jsonc"
WORKER_NAME="$WORKER_NAME" APP_ORIGIN="$APP_ORIGIN" ALIPAY_GATEWAY="$ALIPAY_GATEWAY" node <<'NODE'
const fs = require("node:fs");
const path = "wrangler.jsonc";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.name = process.env.WORKER_NAME;
config.vars ||= {};
config.vars.APP_ORIGIN = process.env.APP_ORIGIN;
config.vars.ALIPAY_GATEWAY = process.env.ALIPAY_GATEWAY;
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

DATABASE_ID="$(node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync("wrangler.jsonc","utf8")); console.log(c.d1_databases?.find(x=>x.binding==="DB")?.database_id||"")')"
if [[ -z "$DATABASE_ID" || "$DATABASE_ID" == replace-* ]]; then
  log "创建 D1 数据库：$DATABASE_NAME"
  node <<'NODE'
const fs = require("node:fs");
const path = "wrangler.jsonc";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.d1_databases = (config.d1_databases || []).filter((item) => item.binding !== "DB");
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
  npx wrangler d1 create "$DATABASE_NAME" --binding DB --update-config
  node <<'NODE'
const fs = require("node:fs");
const path = "wrangler.jsonc";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const database = config.d1_databases?.find((item) => item.binding === "DB");
if (!database?.database_id) throw new Error("Wrangler 未把 D1 database_id 写入配置");
database.migrations_dir = "migrations";
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
else
  log "复用 wrangler.jsonc 中的 D1 数据库：$DATABASE_ID"
fi

TEMP_DIR="$(mktemp -d)"
chmod 700 "$TEMP_DIR"
SECRETS_STORE="$PROJECT_DIR/.cloudflare.secrets.json"
if [[ -f "$SECRETS_STORE" ]]; then
  log "复用本地保存的 Cloudflare Secrets，避免会话与订阅令牌失效"
  node - "$SECRETS_STORE" "$TEMP_DIR" <<'NODE'
const fs = require("node:fs");
const [source, target] = process.argv.slice(2);
const values = JSON.parse(fs.readFileSync(source, "utf8"));
const write = (name, value) => fs.writeFileSync(`${target}/${name}`, String(value || ""));
write("session-secret", values.SESSION_SECRET);
write("bootstrap-secret", values.BOOTSTRAP_SECRET);
write("alipay-app-id", values.ALIPAY_APP_ID);
write("alipay-private-key", values.ALIPAY_PRIVATE_KEY);
write("alipay-public-key", values.ALIPAY_PUBLIC_KEY);
NODE
else
  printf '%s' "$(openssl rand -hex 32)" > "$TEMP_DIR/session-secret"
  printf '%s' "$(openssl rand -hex 32)" > "$TEMP_DIR/bootstrap-secret"
  : > "$TEMP_DIR/alipay-app-id"
  : > "$TEMP_DIR/alipay-private-key"
  : > "$TEMP_DIR/alipay-public-key"
fi
if [[ -n "$ALIPAY_APP_ID" ]]; then
  printf '%s' "$ALIPAY_APP_ID" > "$TEMP_DIR/alipay-app-id"
  cp -- "$ALIPAY_PRIVATE_KEY_FILE" "$TEMP_DIR/alipay-private-key"
  cp -- "$ALIPAY_PUBLIC_KEY_FILE" "$TEMP_DIR/alipay-public-key"
fi
chmod 600 "$TEMP_DIR"/*

node - "$TEMP_DIR" > "$TEMP_DIR/secrets.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const read = (name) => fs.readFileSync(`${path}/${name}`, "utf8").trim();
process.stdout.write(JSON.stringify({
  SESSION_SECRET: read("session-secret"),
  BOOTSTRAP_SECRET: read("bootstrap-secret"),
  ALIPAY_APP_ID: read("alipay-app-id"),
  ALIPAY_PRIVATE_KEY: read("alipay-private-key"),
  ALIPAY_PUBLIC_KEY: read("alipay-public-key"),
}));
NODE
chmod 600 "$TEMP_DIR/secrets.json"
cp -- "$TEMP_DIR/secrets.json" "$SECRETS_STORE"
chmod 600 "$SECRETS_STORE"

log "应用远程 D1 迁移"
npm run db:remote

log "构建并部署 Worker"
npm run build
DEPLOY_ARGS=(--secrets-file "$TEMP_DIR/secrets.json")
if [[ "$CUSTOM_DOMAIN" == "true" ]]; then
  CUSTOM_DOMAIN_HOST="${APP_ORIGIN#https://}"
  DEPLOY_ARGS+=(--domain "$CUSTOM_DOMAIN_HOST")
fi
npx wrangler deploy "${DEPLOY_ARGS[@]}"

if [[ "$SKIP_BOOTSTRAP" != "true" ]]; then
  log "等待部署可访问并创建首次站长账号"
  BOOTSTRAP_SECRET="$(<"$TEMP_DIR/bootstrap-secret")"
  BOOTSTRAP_OK="false"
  for _attempt in $(seq 1 45); do
    if {
      printf '%s\n' "$APP_ORIGIN"
      printf '%s\n' "$OWNER_EMAIL"
      printf '%s\n' "$OWNER_PASSWORD"
      printf '%s\n' "$BOOTSTRAP_SECRET"
    } | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", async () => {
        const [origin, email, password, secret] = input.replace(/\n$/, "").split("\n");
        try {
          const response = await fetch(`${origin}/api/setup/bootstrap`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ email, password, secret }),
          });
          if (response.status === 201 || response.status === 409) process.exit(0);
          console.error(`HTTP ${response.status}: ${await response.text()}`);
          process.exit(1);
        } catch {
          process.exit(1);
        }
      });
    '
    then
      BOOTSTRAP_OK="true"
      break
    fi
    sleep 4
  done
  unset OWNER_PASSWORD BOOTSTRAP_SECRET
  [[ "$BOOTSTRAP_OK" == "true" ]] || die "部署成功，但站长账号初始化失败；请检查域名解析后手动调用 bootstrap 接口"
fi

log "Cloudflare 部署完成"
printf '\n访问地址：%s\n' "$APP_ORIGIN"
if [[ "$SKIP_BOOTSTRAP" != "true" ]]; then
  printf '站长账号：%s\n' "$OWNER_EMAIL"
fi
printf 'Worker：%s\n' "$WORKER_NAME"
