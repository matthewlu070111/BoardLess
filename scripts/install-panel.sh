#!/usr/bin/env bash

set -Eeuo pipefail

PROGRAM_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DOMAIN=""
VERSION=""
REPOSITORY=""
SOURCE_DIR=""
INSTALL_DIR="/opt/boardless"
DATA_DIR="/var/lib/boardless"
DATA_DIR_EXPLICIT="false"
LISTEN_PORT="3000"
LISTEN_PORT_EXPLICIT="false"
WITH_CADDY="false"
WITH_CADDY_EXPLICIT="false"
ACME_EMAIL=""
INPUT_ENV_FILE=""
UNATTENDED="false"
TEMP_DIR=""
EXISTING_INSTALL="false"
OWNER_EMAIL=""
OWNER_PASSWORD_FILE=""
OWNER_PASSWORD=""
SKIP_BOOTSTRAP="false"
CONFIGURE_ALIPAY="false"
ALIPAY_APP_ID_INPUT=""
ALIPAY_PRIVATE_KEY_FILE=""
ALIPAY_PUBLIC_KEY_FILE=""
ALIPAY_GATEWAY_INPUT="https://openapi.alipay.com/gateway.do"

usage() {
  cat <<'EOF'
BoardLess 面板一键安装脚本

用法：
  sudo bash scripts/install-panel.sh --domain panel.example.com [选项]

交互安装无需预先传入参数，脚本会逐项询问。无人值守安装参数如下：

源码参数：
  --source-dir PATH        使用本地 BoardLess 源码目录
  --repository URL         从 GitHub 仓库获取源码
  --version REF            远程安装使用的 Release 标签、分支或提交 SHA

安装参数：
  --install-dir PATH       程序目录，默认 /opt/boardless
  --data-dir PATH          SQLite、备份和 Caddy 数据目录，默认 /var/lib/boardless
  --listen-port PORT       不启用 Caddy 时映射的端口，默认 3000
  --with-caddy             同时启动 Caddy，并监听 80/443
  --acme-email EMAIL       Caddy ACME 通知邮箱
  --env-file PATH          合并已有环境变量文件，例如支付宝配置
  --owner-email EMAIL      首次创建的站长邮箱
  --owner-password-file P  从仅 root 可读文件读取站长密码
  --skip-bootstrap         只安装面板，不自动创建站长账号
  --unattended             无交互执行；缺少必要条件时直接失败
  -h, --help               显示帮助

示例：
  sudo bash scripts/install-panel.sh \
    --domain panel.example.com \
    --with-caddy \
    --acme-email admin@example.com

  curl -fsSL https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh \
    -o /tmp/boardless-install-panel.sh
  sudo bash /tmp/boardless-install-panel.sh \
    --repository https://github.com/matthewlu070111/BoardLess.git \
    --version refs/heads/main \
    --domain panel.example.com \
    --with-caddy \
    --unattended
EOF
}

log() {
  printf '[BoardLess] %s\n' "$*"
}

warn() {
  printf '[BoardLess] 警告：%s\n' "$*" >&2
}

die() {
  printf '[BoardLess] 错误：%s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || die "--domain 缺少参数"
      DOMAIN="$2"
      shift 2
      ;;
    --version)
      [[ $# -ge 2 ]] || die "--version 缺少参数"
      VERSION="$2"
      shift 2
      ;;
    --repository)
      [[ $# -ge 2 ]] || die "--repository 缺少参数"
      REPOSITORY="$2"
      shift 2
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || die "--source-dir 缺少参数"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || die "--install-dir 缺少参数"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || die "--data-dir 缺少参数"
      DATA_DIR="$2"
      DATA_DIR_EXPLICIT="true"
      shift 2
      ;;
    --listen-port)
      [[ $# -ge 2 ]] || die "--listen-port 缺少参数"
      LISTEN_PORT="$2"
      LISTEN_PORT_EXPLICIT="true"
      shift 2
      ;;
    --with-caddy)
      WITH_CADDY="true"
      WITH_CADDY_EXPLICIT="true"
      shift
      ;;
    --acme-email)
      [[ $# -ge 2 ]] || die "--acme-email 缺少参数"
      ACME_EMAIL="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file 缺少参数"
      INPUT_ENV_FILE="$2"
      shift 2
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

[[ "$(id -u)" -eq 0 ]] || die "请使用 sudo 或 root 运行该脚本"
[[ "$(uname -s)" == "Linux" ]] || die "当前一键安装脚本仅支持 Linux"

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

if [[ "$UNATTENDED" != "true" ]]; then
  printf '\nBoardLess 交互式安装\n按回车可接受方括号中的默认值。\n\n'
  INSTALL_DIR="$(prompt_default "程序安装目录" "$INSTALL_DIR")"
  DATA_DIR="$(prompt_default "数据库与备份目录" "$DATA_DIR")"
  if [[ -z "$DOMAIN" ]]; then
    read -r -p "面板域名（不含 https://）：" DOMAIN
  fi
  if [[ "$WITH_CADDY_EXPLICIT" != "true" ]]; then
    if prompt_yes_no "是否由脚本配置 Caddy 和 HTTPS" "yes"; then
      WITH_CADDY="true"
    fi
  fi
  if [[ "$WITH_CADDY" == "true" && -z "$ACME_EMAIL" ]]; then
    read -r -p "证书通知邮箱（可留空）：" ACME_EMAIL
  elif [[ "$WITH_CADDY" != "true" && "$LISTEN_PORT_EXPLICIT" != "true" ]]; then
    LISTEN_PORT="$(prompt_default "面板监听端口" "$LISTEN_PORT")"
  fi

  if [[ ! -f "$INSTALL_DIR/compose.install.yml" && "$SKIP_BOOTSTRAP" != "true" ]]; then
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

  if [[ -z "$INPUT_ENV_FILE" ]] && prompt_yes_no "现在配置支付宝当面付" "no"; then
    CONFIGURE_ALIPAY="true"
    read -r -p "支付宝应用 ID：" ALIPAY_APP_ID_INPUT
    read -r -p "应用私钥 PEM 文件路径：" ALIPAY_PRIVATE_KEY_FILE
    read -r -p "支付宝公钥 PEM 文件路径：" ALIPAY_PUBLIC_KEY_FILE
    if prompt_yes_no "是否使用支付宝沙箱网关" "yes"; then
      ALIPAY_GATEWAY_INPUT="https://openapi.alipaydev.com/gateway.do"
    fi
  fi
fi

[[ -n "$DOMAIN" ]] || die "必须提供面板域名"
[[ "$DOMAIN" =~ ^([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]|localhost)$ ]] || die "--domain 格式无效，只填写域名，不包含协议或路径"
[[ "$LISTEN_PORT" =~ ^[0-9]+$ ]] || die "--listen-port 必须是整数"
(( LISTEN_PORT >= 1 && LISTEN_PORT <= 65535 )) || die "--listen-port 必须在 1-65535 之间"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || die "--install-dir 必须是非根目录的绝对路径"
[[ "$DATA_DIR" == /* && "$DATA_DIR" != "/" ]] || die "--data-dir 必须是非根目录的绝对路径"
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--install-dir 只能包含字母、数字、点、下划线、斜杠和连字符"
[[ "$DATA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--data-dir 只能包含字母、数字、点、下划线、斜杠和连字符"
[[ "$INSTALL_DIR" != "$DATA_DIR" ]] || die "--install-dir 和 --data-dir 不能相同"
[[ "$INSTALL_DIR" != *$'\n'* && "$DATA_DIR" != *$'\n'* ]] || die "目录路径不能包含换行符"

if [[ -n "$REPOSITORY" && -n "$SOURCE_DIR" ]]; then
  die "--repository 和 --source-dir 不能同时使用"
fi
if [[ -n "$REPOSITORY" ]]; then
  [[ "$REPOSITORY" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]] || die "--repository 只接受 GitHub HTTPS 仓库地址"
  [[ -n "$VERSION" ]] || die "远程安装必须通过 --version 固定版本"
  [[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$VERSION" != *..* ]] || die "--version 包含不安全字符"
  [[ "$VERSION" != "main" && "$VERSION" != "master" && "$VERSION" != "HEAD" ]] || die "远程安装不能使用可变的 main、master 或 HEAD"
fi
if [[ -n "$INPUT_ENV_FILE" ]]; then
  [[ -f "$INPUT_ENV_FILE" ]] || die "环境变量文件不存在：$INPUT_ENV_FILE"
  INPUT_ENV_FILE="$(cd "$(dirname "$INPUT_ENV_FILE")" && pwd)/$(basename "$INPUT_ENV_FILE")"
fi
if [[ -n "$ACME_EMAIL" ]]; then
  [[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "--acme-email 格式无效"
fi
if [[ -n "$OWNER_PASSWORD_FILE" ]]; then
  [[ -f "$OWNER_PASSWORD_FILE" ]] || die "站长密码文件不存在：$OWNER_PASSWORD_FILE"
  OWNER_PASSWORD="$(<"$OWNER_PASSWORD_FILE")"
fi
if [[ "$UNATTENDED" == "true" && ! -f "$INSTALL_DIR/compose.install.yml" && "$SKIP_BOOTSTRAP" != "true" ]]; then
  [[ -n "$OWNER_EMAIL" && -n "$OWNER_PASSWORD_FILE" ]] || die "无人值守首次安装需要 --owner-email 和 --owner-password-file，或使用 --skip-bootstrap"
fi
if [[ ! -f "$INSTALL_DIR/compose.install.yml" && "$SKIP_BOOTSTRAP" != "true" ]]; then
  [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "首次站长邮箱格式无效"
  (( ${#OWNER_PASSWORD} >= 10 && ${#OWNER_PASSWORD} <= 128 )) || die "首次站长密码必须为 10-128 位"
  [[ "$OWNER_PASSWORD" != *$'\n'* ]] || die "站长密码不能包含换行符"
fi
if [[ "$CONFIGURE_ALIPAY" == "true" ]]; then
  [[ -n "$ALIPAY_APP_ID_INPUT" ]] || die "支付宝应用 ID 不能为空"
  [[ -f "$ALIPAY_PRIVATE_KEY_FILE" ]] || die "应用私钥文件不存在"
  [[ -f "$ALIPAY_PUBLIC_KEY_FILE" ]] || die "支付宝公钥文件不存在"
fi

install_packages() {
  local packages=(ca-certificates curl git openssl tar)
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "${packages[@]}"
  else
    die "无法自动安装依赖；请先安装 curl、git、openssl 和 tar"
  fi
}

ensure_base_tools() {
  local missing="false"
  for tool in curl git openssl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing="true"
    fi
  done
  if [[ "$missing" == "true" ]]; then
    log "安装基础依赖"
    install_packages
  fi
}

ensure_docker() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    . /etc/os-release
    case "${ID:-}" in
      ubuntu|debian)
        local docker_codename="${VERSION_CODENAME:-}"
        if [[ "${ID}" == "ubuntu" && -n "${UBUNTU_CODENAME:-}" ]]; then
          docker_codename="$UBUNTU_CODENAME"
        fi
        [[ -n "$docker_codename" ]] || die "无法识别 ${ID} 的 Debian 发行版代号，不能配置 Docker 官方源"
        log "配置 Docker 官方 APT 源（${ID} ${docker_codename}）"
        apt-get update
        apt-get install -y ca-certificates curl
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/${ID}/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
          "$(dpkg --print-architecture)" "$ID" "$docker_codename" \
          > /etc/apt/sources.list.d/docker.list
        apt-get update
        if ! command -v docker >/dev/null 2>&1; then
          log "安装 Docker"
          apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        elif ! docker compose version >/dev/null 2>&1; then
          log "安装 Docker Compose 插件"
          apt-get install -y docker-compose-plugin
        fi
        ;;
      *)
        if ! command -v docker >/dev/null 2>&1; then
          apt-get update
          apt-get install -y docker.io
        fi
        apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin
        ;;
    esac
  elif ! command -v docker >/dev/null 2>&1; then
    log "安装 Docker"
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y docker docker-compose-plugin
    elif command -v yum >/dev/null 2>&1; then
      yum install -y docker docker-compose-plugin
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache docker docker-cli-compose
    else
      die "无法自动安装 Docker，请先按发行版官方文档安装 Docker Engine 与 Compose 插件"
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  fi
  docker info >/dev/null 2>&1 || die "Docker daemon 不可用"
  docker compose version >/dev/null 2>&1 || die "缺少 Docker Compose v2 插件"
}

ensure_base_tools
ensure_docker

TEMP_DIR="$(mktemp -d)"

if [[ -n "$REPOSITORY" ]]; then
  log "获取 BoardLess 源码：$REPOSITORY @ $VERSION"
  SOURCE_DIR="$TEMP_DIR/source"
  git init -q "$SOURCE_DIR"
  git -C "$SOURCE_DIR" remote add origin "$REPOSITORY"
  git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$VERSION"
  git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD
  VERSION="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
elif [[ -z "$SOURCE_DIR" ]]; then
  SOURCE_DIR="$DEFAULT_SOURCE_DIR"
else
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
fi

[[ -f "$SOURCE_DIR/package.json" ]] || die "源码目录缺少 package.json：$SOURCE_DIR"
[[ -f "$SOURCE_DIR/package-lock.json" ]] || die "源码目录缺少 package-lock.json：$SOURCE_DIR"
[[ -f "$SOURCE_DIR/Dockerfile" ]] || die "源码目录缺少 Dockerfile：$SOURCE_DIR"
[[ -d "$SOURCE_DIR/migrations" ]] || die "源码目录缺少 migrations：$SOURCE_DIR"

if [[ -f "$INSTALL_DIR/.install.env" ]]; then
  OLD_DATA_DIR="$(sed -n 's/^BOARDLESS_DATA_DIR=//p' "$INSTALL_DIR/.install.env" | tail -n 1)"
  OLD_LISTEN_PORT="$(sed -n 's/^BOARDLESS_LISTEN_PORT=//p' "$INSTALL_DIR/.install.env" | tail -n 1)"
  if [[ "$DATA_DIR_EXPLICIT" == "false" && -n "$OLD_DATA_DIR" ]]; then
    DATA_DIR="$OLD_DATA_DIR"
  elif [[ -n "$OLD_DATA_DIR" && "$DATA_DIR" != "$OLD_DATA_DIR" ]]; then
    die "升级时不能直接更换数据目录（当前：$OLD_DATA_DIR）；请先手动迁移数据"
  fi
  if [[ "$LISTEN_PORT_EXPLICIT" == "false" && -n "$OLD_LISTEN_PORT" ]]; then
    LISTEN_PORT="$OLD_LISTEN_PORT"
  fi
fi
if [[ -f "$INSTALL_DIR/compose.install.yml" ]] && grep -q '^  caddy:' "$INSTALL_DIR/compose.install.yml"; then
  WITH_CADDY="true"
  if [[ -z "$ACME_EMAIL" && -f "$INSTALL_DIR/Caddyfile" ]]; then
    ACME_EMAIL="$(sed -n 's/^[[:space:]]*email[[:space:]]\+//p' "$INSTALL_DIR/Caddyfile" | head -n 1)"
  fi
fi

[[ "$DATA_DIR" == /* && "$DATA_DIR" != "/" ]] || die "现有数据目录配置无效：$DATA_DIR"
[[ "$DATA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "现有数据目录包含不支持的字符：$DATA_DIR"
[[ "$LISTEN_PORT" =~ ^[0-9]+$ ]] || die "现有监听端口配置无效：$LISTEN_PORT"
(( LISTEN_PORT >= 1 && LISTEN_PORT <= 65535 )) || die "现有监听端口必须在 1-65535 之间"
[[ "$INSTALL_DIR" != "$DATA_DIR" ]] || die "--install-dir 和数据目录不能相同"
[[ "$DATA_DIR" != *$'\n'* ]] || die "数据目录不能包含换行符"

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/backups"
chmod 700 "$DATA_DIR" "$DATA_DIR/backups"

if [[ -f "$INSTALL_DIR/compose.install.yml" ]]; then
  EXISTING_INSTALL="true"
  log "检测到已有安装，将执行备份和安全升级"
  if [[ -f "$INSTALL_DIR/.install.env" ]]; then
    docker compose --env-file "$INSTALL_DIR/.install.env" -f "$INSTALL_DIR/compose.install.yml" stop boardless >/dev/null 2>&1 || true
  fi
  if [[ -f "$DATA_DIR/boardless.sqlite" ]]; then
    BACKUP_PATH="$DATA_DIR/backups/boardless-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
    cp -p -- "$DATA_DIR/boardless.sqlite" "$BACKUP_PATH"
    chmod 600 "$BACKUP_PATH"
    log "数据库已备份：$BACKUP_PATH"
  fi
  if [[ -f "$INSTALL_DIR/.install.env" ]]; then
    docker compose --env-file "$INSTALL_DIR/.install.env" -f "$INSTALL_DIR/compose.install.yml" start boardless >/dev/null 2>&1 || true
  fi
fi

if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
  log "安装程序文件到 $INSTALL_DIR"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.wrangler' \
    --exclude='.dev.vars' \
    --exclude='.env' \
    --exclude='.env.docker' \
    --exclude='data' \
    -C "$SOURCE_DIR" -cf - . | tar -C "$INSTALL_DIR" -xf -
else
  log "直接使用安装目录中的现有源码"
fi

ENV_FILE="$INSTALL_DIR/.env.docker"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -n "$INPUT_ENV_FILE" ]]; then
    cp -- "$INPUT_ENV_FILE" "$ENV_FILE"
  else
    : > "$ENV_FILE"
  fi
fi
chmod 600 "$ENV_FILE"

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env() {
  local key="$1"
  local value="$2"
  local temp_file="$TEMP_DIR/env"
  awk -v key="$key" -F= '$1 != key { print }' "$ENV_FILE" > "$temp_file"
  printf '%s=%s\n' "$key" "$value" >> "$temp_file"
  mv "$temp_file" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

dotenv_pem_value() {
  local file="$1"
  local result=""
  local line=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//\\/\\\\}"
    line="${line//\"/\\\"}"
    result+="${line}\\n"
  done < "$file"
  result="${result%\\n}"
  printf '"%s"' "$result"
}

if [[ -n "$INPUT_ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$line" == *=* && "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "环境变量文件包含无效行，只支持 KEY=VALUE"
    set_env "$key" "$value"
  done < "$INPUT_ENV_FILE"
fi
if [[ "$CONFIGURE_ALIPAY" == "true" ]]; then
  set_env ALIPAY_APP_ID "$ALIPAY_APP_ID_INPUT"
  set_env ALIPAY_PRIVATE_KEY "$(dotenv_pem_value "$ALIPAY_PRIVATE_KEY_FILE")"
  set_env ALIPAY_PUBLIC_KEY "$(dotenv_pem_value "$ALIPAY_PUBLIC_KEY_FILE")"
  set_env ALIPAY_GATEWAY "$ALIPAY_GATEWAY_INPUT"
fi

if [[ -z "$(env_value SESSION_SECRET)" || "$(env_value SESSION_SECRET)" == replace-* ]]; then
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
fi
if [[ -z "$(env_value BOOTSTRAP_SECRET)" || "$(env_value BOOTSTRAP_SECRET)" == replace-* ]]; then
  set_env BOOTSTRAP_SECRET "$(openssl rand -hex 32)"
fi
set_env APP_ORIGIN "https://$DOMAIN"
[[ -n "$(env_value ALIPAY_APP_ID)" ]] || set_env ALIPAY_APP_ID ""
[[ -n "$(env_value ALIPAY_PRIVATE_KEY)" ]] || set_env ALIPAY_PRIVATE_KEY ""
[[ -n "$(env_value ALIPAY_PUBLIC_KEY)" ]] || set_env ALIPAY_PUBLIC_KEY ""
[[ -n "$(env_value ALIPAY_GATEWAY)" ]] || set_env ALIPAY_GATEWAY "https://openapi.alipay.com/gateway.do"

cat > "$INSTALL_DIR/.install.env" <<EOF
BOARDLESS_DATA_DIR=$DATA_DIR
BOARDLESS_LISTEN_PORT=$LISTEN_PORT
EOF
chmod 600 "$INSTALL_DIR/.install.env"

if [[ "$WITH_CADDY" == "true" ]]; then
  mkdir -p "$DATA_DIR/caddy-data" "$DATA_DIR/caddy-config"
  if [[ -n "$ACME_EMAIL" ]]; then
    cat > "$INSTALL_DIR/Caddyfile" <<EOF
{
  email $ACME_EMAIL
}

$DOMAIN {
  encode zstd gzip
  reverse_proxy boardless:3000
}
EOF
  else
    cat > "$INSTALL_DIR/Caddyfile" <<EOF
$DOMAIN {
  encode zstd gzip
  reverse_proxy boardless:3000
}
EOF
  fi
  cat > "$INSTALL_DIR/compose.install.yml" <<'EOF'
services:
  boardless:
    build:
      context: .
    env_file:
      - .env.docker
    volumes:
      - type: bind
        source: ${BOARDLESS_DATA_DIR}
        target: /data
    expose:
      - "3000"
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    depends_on:
      - boardless
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${BOARDLESS_DATA_DIR}/caddy-data:/data
      - ${BOARDLESS_DATA_DIR}/caddy-config:/config
    restart: unless-stopped
EOF
else
  cat > "$INSTALL_DIR/compose.install.yml" <<'EOF'
services:
  boardless:
    build:
      context: .
    env_file:
      - .env.docker
    ports:
      - "${BOARDLESS_LISTEN_PORT}:3000"
    volumes:
      - type: bind
        source: ${BOARDLESS_DATA_DIR}
        target: /data
    restart: unless-stopped
EOF
fi

cat > "$INSTALL_DIR/boardlessctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose() {
  docker compose --env-file "$INSTALL_DIR/.install.env" -f "$INSTALL_DIR/compose.install.yml" "$@"
}
case "${1:-}" in
  start) compose up -d ;;
  stop) compose stop ;;
  restart) compose restart ;;
  status) compose ps ;;
  logs) shift; compose logs "$@" ;;
  *) echo "用法：$0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
EOF
chmod 700 "$INSTALL_DIR/boardlessctl"

compose() {
  docker compose --env-file "$INSTALL_DIR/.install.env" -f "$INSTALL_DIR/compose.install.yml" "$@"
}

log "构建并启动 BoardLess"
compose up -d --build --remove-orphans

log "等待健康检查"
HEALTHY="false"
for _attempt in $(seq 1 60); do
  if compose exec -T boardless node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    HEALTHY="true"
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != "true" ]]; then
  compose logs --tail 100 boardless >&2 || true
  die "健康检查失败，请查看上方日志"
fi

if [[ "$EXISTING_INSTALL" != "true" && "$SKIP_BOOTSTRAP" != "true" ]]; then
  log "创建首次站长账号"
  if ! BOOTSTRAP_RESULT="$({
    printf '%s\n' "$OWNER_EMAIL"
    printf '%s\n' "$OWNER_PASSWORD"
  } | compose exec -T boardless node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", async () => {
      const [email, password] = input.replace(/\n$/, "").split("\n");
      const response = await fetch("http://127.0.0.1:3000/api/setup/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", "origin": process.env.APP_ORIGIN },
        body: JSON.stringify({ email, password, secret: process.env.BOOTSTRAP_SECRET }),
      });
      const body = await response.text();
      if (!response.ok) {
        console.error(`HTTP ${response.status}: ${body}`);
        process.exit(1);
      }
    });
  ' 2>&1)"; then
    unset OWNER_PASSWORD
    die "站长账号初始化失败：$BOOTSTRAP_RESULT"
  fi
  unset OWNER_PASSWORD BOOTSTRAP_RESULT
fi

if [[ "$WITH_CADDY" == "true" ]]; then
  PUBLIC_URL="https://$DOMAIN"
else
  PUBLIC_URL="https://$DOMAIN（请先配置 HTTPS 反向代理到端口 $LISTEN_PORT）"
fi

log "安装完成"
printf '\n访问地址：%s\n' "$PUBLIC_URL"
printf '安装目录：%s\n' "$INSTALL_DIR"
printf '数据目录：%s\n' "$DATA_DIR"
if [[ -n "$VERSION" ]]; then
  printf '安装版本：%s\n' "$VERSION"
fi
printf '\n管理命令：\n'
printf '  %s/boardlessctl status\n' "$INSTALL_DIR"
printf '  %s/boardlessctl logs\n' "$INSTALL_DIR"
printf '  %s/boardlessctl restart\n' "$INSTALL_DIR"
if [[ "$EXISTING_INSTALL" != "true" && "$SKIP_BOOTSTRAP" != "true" ]]; then
  printf '站长账号：%s（已创建）\n' "$OWNER_EMAIL"
elif [[ "$SKIP_BOOTSTRAP" == "true" ]]; then
  printf '\n已跳过站长账号创建。需要时可仅在服务器上读取初始化密钥：\n'
  printf "  sudo sed -n 's/^BOOTSTRAP_SECRET=//p' '%s'\n" "$ENV_FILE"
fi
if [[ "$EXISTING_INSTALL" == "true" ]]; then
  printf '本次为升级安装；数据库备份位于 %s/backups。\n' "$DATA_DIR"
fi
