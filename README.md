# BoardLess

BoardLess 是一个轻量的订阅与节点管理面板，提供用户中心、管理员后台、站长控制台和节点 API。前端使用 React，API 基于 Hono，可部署到 Cloudflare Workers + D1，也可通过 Docker + SQLite 自托管。

> BoardLess 只负责面板、订阅、订单与节点数据下发，不包含代理节点进程，也不会自动配置 Xray、sing-box 等服务。

## 功能

- 用户：查看套餐与流量、支付宝扫码购买、续费或升级、获取和轮换订阅链接
- 管理员：维护自己的节点、邀请用户、查看销售收益并发起提现
- 站长：审核节点、管理套餐与账号、配置支付方式、处理提现、查看订单和审计日志
- 节点：拉取授权用户与协议配置，上报心跳和增量流量
- 后端仓库：导入兼容 GitHub 仓库，校验 README 特征码与脚本哈希，通过预设生成一次性节点安装命令
- 订阅：输出 Clash、sing-box、Surge 和 Base64 通用订阅
- 协议：Shadowsocks、VMess、VLESS、Trojan、Hysteria 2、TUIC
- 支付：站长后台配置支付宝当面付，支持异步通知、主动查询和重复回调幂等处理

## 推荐后端

| 后端 | 简介 | 支持的预设 |
| --- | --- | --- |
| [matthewlu070111/BoardRay](https://github.com/matthewlu070111/BoardRay) | 由 Xray 驱动的节点 Agent，可接入 BoardLess，并安全地拉取用户、应用配置和上报流量。 | VLESS + TCP + TLS + XTLS Vision；VLESS + TCP/RAW + REALITY + XTLS Vision |

## 技术栈

| 层 | 实现 |
| --- | --- |
| Web | React 19、React Router、Vite |
| API | Hono |
| Cloudflare | Workers、D1、静态资源托管、Cron Trigger |
| 自托管 | Node.js、SQLite、Docker Compose |
| 测试 | Vitest、TypeScript |

## 快速开始

生产部署只推荐以下两种方式。

### 方式一：Linux 一键安装（推荐）

准备一台 Linux 服务器，使用 `curl` 下载脚本并立即启动交互安装：

```bash
curl -fsSL 'https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh' -o /tmp/boardless-install.sh && sudo bash /tmp/boardless-install.sh --repository 'https://github.com/matthewlu070111/BoardLess.git' --version 'refs/heads/main'
```

没有 `curl` 时可改用 `wget`：

```bash
wget -qO /tmp/boardless-install.sh 'https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh' && sudo bash /tmp/boardless-install.sh --repository 'https://github.com/matthewlu070111/BoardLess.git' --version 'refs/heads/main'
```

脚本不会把远程内容直接管道给 root shell；下载完成后才执行，因此仍可正常逐项询问：

- 面板域名、安装目录和数据目录
- 是否自动配置 Caddy 与 HTTPS
- 首次站长邮箱和密码
- 是否配置支付宝，以及应用 ID、公私钥和沙箱环境

随后自动安装 Docker 依赖、生成密钥、构建服务、初始化数据库、创建站长账号并完成健康检查。

### 方式二：Cloudflare 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fmatthewlu070111%2FBoardLess)

点击按钮后登录 Cloudflare，确认 Worker、D1 和 Secrets 配置即可部署。Cloudflare 会复制公开仓库、创建并绑定 D1、执行迁移，然后构建发布 Worker。部署完成后，将 `APP_ORIGIN` 设置为 Worker 的最终 HTTPS 地址，并使用 `BOOTSTRAP_SECRET` 创建首次站长账号。

部署完成后，创建站长账号：
```bash
curl -X POST 'https://boardless.xxxxx.workers.dev/api/setup/bootstrap' \
  -H 'content-type: application/json' \
  -H 'origin: https://boardless.xxxxx.workers.dev' \
  -d '{
    "secret":"你的BOOTSTRAP_SECRET",
    "email":"admin@example.com",
    "password":"10位以上的密码"
  }'
```

## 更新与回滚

Linux 自托管安装建议使用稳定版本标签（例如 `v0.2.0`）或提交 SHA。Cloudflare 部署由 Workers Builds 持续监听 BoardLess 原始仓库的生产分支，并在该分支收到新 commit 后自动构建和部署。

### Cloudflare 更新

Deploy to Cloudflare 完成首次部署后，Workers Builds 会持续跟踪 BoardLess 原始仓库的生产分支（默认是 `main`）。原始仓库出现新 commit 时，Cloudflare 会自动读取该 commit、执行部署命令并发布新版本；站长无需手工同步仓库、拉取代码或再次运行一键部署脚本。

本项目在 `package.json` 中定义的 Cloudflare 部署命令为：

```bash
npm run deploy
```

该命令会依次构建项目、对绑定为 `DB` 的远程 D1 执行尚未应用的 migration，然后部署 Worker。Cloudflare 部署按钮会识别这个自定义 `deploy` 脚本并预填到 Workers Builds；可在 Cloudflare 控制台的 **Settings → Builds** 中确认 Deploy command 是 `npm run deploy`。如果被改成单独的 `npx wrangler deploy`，代码仍会更新，但新的 D1 migration 不会自动执行。

通过 Workers Builds 更新时会继续使用 Worker 中已有的变量、Secrets 和 D1 绑定，不会重新生成 `SESSION_SECRET`，也不会清空用户、订单、节点或支付配置。`wrangler d1 migrations apply` 在应用 migration 时会创建 D1 备份；重要更新前仍建议使用 D1 Time Travel 或额外导出数据库。

回滚代码时，可以在仓库中 revert 对应 commit 并推送到生产分支，让 Workers Builds 自动重新部署。已应用的 D1 migration 不会随代码 commit 自动回滚，需要回退数据库时应使用 D1 备份或 Time Travel 单独处理。

仓库中的 `scripts/deploy-cloudflare.sh` 主要用于本地 CLI 手动部署。只有采用这种方式时，才依赖本地 `.cloudflare.secrets.json` 来保持重复部署时的密钥不变；通过部署按钮和 Workers Builds 自动更新不需要运行该脚本。

### Linux 一键安装更新

重新下载最新安装脚本，并使用原来的域名、安装目录和数据目录执行。下面示例更新到 `v0.2.0`：

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh' \
  -o /tmp/boardless-update.sh

sudo bash /tmp/boardless-update.sh \
  --repository 'https://github.com/matthewlu070111/BoardLess.git' \
  --version 'v0.2.0' \
  --domain 'panel.example.com' \
  --install-dir '/opt/boardless' \
  --data-dir '/var/lib/boardless' \
  --with-caddy \
  --skip-bootstrap \
  --unattended
```

如果首次安装没有使用 Caddy，应去掉 `--with-caddy`，并按需继续传入原来的 `--listen-port`。`--version` 也可以填写确定的提交 SHA。

脚本检测到已有的 `compose.install.yml` 后会执行安全升级：停止 BoardLess 容器，将 SQLite 复制到数据目录下的 `backups/`，保留原有 `.env.docker` 和密钥，覆盖程序文件，重新构建镜像并启动服务。容器启动时会自动执行尚未应用的 SQLite migration，随后脚本会等待健康检查通过。

升级失败时可通过以下命令查看日志：

```bash
sudo /opt/boardless/boardlessctl status
sudo /opt/boardless/boardlessctl logs --tail 200 boardless
```

需要回滚时，应重新运行安装脚本安装原来的版本标签或提交 SHA，并在停止服务后恢复 `/var/lib/boardless/backups/` 中对应的 SQLite 备份。恢复数据库会覆盖升级后的数据，执行前应额外保留当前数据库副本。

## 本地开发

本地开发要求 Node.js 22.12+ 和 npm：

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

编辑 `.dev.vars`，至少替换 `SESSION_SECRET` 和 `BOOTSTRAP_SECRET`。开发服务器默认运行在 <http://localhost:5173>。

本地首次创建站长账号：

```bash
curl -X POST http://localhost:5173/api/setup/bootstrap \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' \
  -d '{"secret":"BOOTSTRAP_SECRET 的值","email":"owner@example.com","password":"请替换为高强度密码"}'
```

创建成功后可访问：

- 用户登录：<http://localhost:5173/login>
- 管理后台：<http://localhost:5173/admin/login>
- 健康检查：<http://localhost:5173/api/health>

## 角色与权限

| 角色 | 入口 | 主要权限 |
| --- | --- | --- |
| 用户 | `/login` | 购买套餐、查看流量与订单、获取订阅 |
| 管理员 | `/admin/login` | 邀请用户、提交节点、查看收益、申请提现 |
| 站长 | `/admin/login` | 管理全站用户、节点、套餐、订单、提现与审计日志 |

账号不开放自由注册。站长通过控制台邀请管理员，管理员再邀请用户；邀请链接默认有效 72 小时。

## 后端仓库与节点一键安装

站长可在“后端仓库”页面导入公开 GitHub 仓库。BoardLess 服务端会把分支或标签解析为不可变提交 SHA，读取该提交的 README，验证 `BOARDLESS_BACKEND_REPOSITORY_V1` 特征码、结构化预设和安装脚本 SHA-256。站长确认后，管理员可在“一键部署”页面选择预设并填写必需参数，系统会创建待审核节点并生成五分钟内单次有效的服务器安装命令。

节点 Agent 完成安装后使用一次性令牌调用 `/api/node/v1/bootstrap`，提交 README 已声明的公开生成字段并换取正式节点令牌。私钥必须始终保留在节点服务器；节点用户、凭据、套餐期限和配额只从 BoardLess `/api/node/v1/config` 获取。后端仓库的 README 格式和安装脚本参数见 [DEV.md](DEV.md#8-后端一键配置与安装规范)。

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `APP_ORIGIN` | 是 | 面板的完整公开来源，例如 `https://panel.example.com`，不要带末尾斜杠 |
| `SESSION_SECRET` | 是 | 会话与订阅令牌签名密钥，建议使用至少 32 字节的随机值 |
| `BOOTSTRAP_SECRET` | 是 | 首次创建站长账号时使用的单次密钥 |
| `ALIPAY_APP_ID` | 后台未配置支付时 | 支付宝应用 ID，作为站长后台配置的兼容回退 |
| `ALIPAY_PRIVATE_KEY` | 后台未配置支付时 | 应用私钥，PKCS#8 PEM 格式，作为兼容回退 |
| `ALIPAY_PUBLIC_KEY` | 后台未配置支付时 | 支付宝公钥，PEM 格式，作为兼容回退 |
| `ALIPAY_GATEWAY` | 否 | 回退配置使用的支付宝网关；本地默认沙箱，生产环境使用正式网关 |

Docker 模式还支持以下可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `/data/boardless.sqlite` | SQLite 文件路径 |
| `PUBLIC_DIR` | `/app/dist/client` | 前端静态文件目录 |
| `MIGRATIONS_DIR` | `/app/migrations` | 数据库迁移目录 |

## Cloudflare 手动部署

生产环境优先使用快速开始中的 `scripts/deploy-cloudflare.sh`。以下步骤仅用于需要完全手动控制的场景。

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create boardless
```

将命令返回的 `database_id` 写入 `wrangler.jsonc`，并把其中的 `APP_ORIGIN` 改为生产域名。生产支付还需要将 `ALIPAY_GATEWAY` 改为：

```text
https://openapi.alipay.com/gateway.do
```

### 2. 设置 Secrets

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler secret put ALIPAY_APP_ID
npx wrangler secret put ALIPAY_PRIVATE_KEY
npx wrangler secret put ALIPAY_PUBLIC_KEY
```

### 3. 迁移并发布

```bash
npm run deploy
```

`npm run deploy` 会先构建项目、应用远程 D1 迁移，再发布 Worker。

发布后，将上文初始化请求中的地址和 `Origin` 换成实际域名，再创建站长账号。

`wrangler.jsonc` 已配置每日定时任务，用于结算已过期权益和节点分成。

## Docker 手动部署

生产环境优先使用快速开始中的 `scripts/install-panel.sh`。Docker 模式将前端、API 和 SQLite 打包为一个服务，容器启动时自动执行尚未应用的数据库迁移。手动安装步骤如下：

```bash
cp .env.docker.example .env.docker
docker compose up -d --build
```

编辑 `.env.docker` 时，必须替换 `SESSION_SECRET` 和 `BOOTSTRAP_SECRET`，并把 `APP_ORIGIN` 设为用户实际访问的地址。启动后打开 <http://localhost:3000>，首次初始化接口也改用端口 `3000`。

手动安装的数据保存在 Docker volume `boardless-data`；一键安装使用宿主机持久化目录。生产环境建议：

- 使用 Caddy、Nginx 或云负载均衡提供 HTTPS
- 备份 `/data/boardless.sqlite` 对应的数据卷
- 不要将 `.env.docker`、私钥或数据库文件提交到版本库
- 升级前先备份数据库，再重新构建镜像

## 支付方式配置

站长登录后可在“支付对接”页面填写支付宝应用 ID、应用私钥、支付宝公钥和网关地址，并随时启用或停用该渠道。支付凭据使用 `SESSION_SECRET` 派生的密钥加密后存入数据库，API 不会向浏览器回显私钥；更换 `SESSION_SECRET` 后需要重新保存支付凭据。

部署环境中的 `ALIPAY_*` 变量保留为兼容回退：后台尚未保存支付宝配置时，系统继续读取环境变量；一旦站长在后台保存配置，新订单就使用数据库中的配置。当前内置适配器为支付宝当面付，微信支付、Stripe 等渠道仍需实现对应的签名、下单、回调和查单适配器后才能启用。

### 支付宝

支付宝应用需开通“当面付”。BoardLess 发起的异步通知地址为：

```text
https://你的域名/api/payments/alipay/notify
```

通过站长后台保存的配置会使用带支付方式 ID 的通知地址，具体地址由系统创建订单时自动提交给支付宝，无需手工拼接。

建议先使用沙箱完成以下验证，再切换正式网关：

1. 扫码支付后订单可正常生效
2. 浏览器主动查询可补偿延迟通知
3. 重复通知不会重复入账
4. 金额或签名不匹配时回调会被拒绝

提现不会自动调用支付宝转账接口：管理员提交申请后，站长需线下转账并录入流水号。

## 节点接入

管理员或站长创建节点时，面板只显示一次节点令牌。节点程序需使用该令牌拉取配置、发送心跳并上报流量：

```http
Authorization: Bearer <node-token>
```

完整接口、请求示例和状态约定见 [节点 API 文档](docs/node-api.md)。前端、节点 Agent 和第三方服务的完整后端接入方式见 [开发接入指南](DEV.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地开发服务器 |
| `npm run db:local` | 将迁移应用到本地 D1 |
| `npm run db:remote` | 将迁移应用到远程 D1 |
| `npm run typecheck` | 执行 TypeScript 类型检查 |
| `npm test` | 运行测试 |
| `npm run build` | 构建 Cloudflare 版本 |
| `npm run build:docker` | 构建 Docker/Node.js 版本 |
| `npm run deploy` | 构建、迁移远程 D1 并发布到 Cloudflare |
| `npm run deploy:cloudflare` | 启动 Cloudflare 交互式一键部署 |

提交改动前建议运行：

```bash
npm run typecheck
npm test
npm run build
npm run build:docker
```

## 项目结构

```text
src/
├── client/          React 前端
├── node/            Node.js + SQLite 运行时
└── worker/          Hono API、认证、支付、订阅与业务逻辑
migrations/          D1 / SQLite 数据库迁移
scripts/
├── install-panel.sh       Linux 自托管交互式安装
└── deploy-cloudflare.sh   Cloudflare 交互式部署
DEV.md                后端 API 与客户端接入指南
docs/node-api.md      节点对接文档
wrangler.jsonc       Cloudflare 配置
docker-compose.yml   Docker Compose 配置
```

## 安全说明

- 节点令牌、邀请令牌和会话令牌应视为敏感凭据；泄露后立即轮换
- `APP_ORIGIN` 必须与实际访问来源完全一致，否则写操作会被来源校验拒绝
- 生产环境必须启用 HTTPS，并妥善保存支付宝私钥和数据库备份
- 订阅链接包含访问凭据，不应公开分享；用户可在面板中轮换链接使旧链接失效
- 本项目尚未提供邮件发送、自动退款或自动支付宝转账能力

## License

仓库当前未声明开源许可证。未经作者许可，请勿默认将代码视为可自由复制、修改或分发。
