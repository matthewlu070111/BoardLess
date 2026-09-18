# BoardLess 后端接入指南

本文面向前端开发者、节点 Agent 开发者和需要对接 BoardLess API 的服务端开发者。接口实现以 [`src/worker/index.ts`](src/worker/index.ts) 为准。

## 1. 基本约定

### 地址

本地开发环境：

```text
http://localhost:5173
```

Docker 默认环境：

```text
http://localhost:3000
```

生产环境使用 `APP_ORIGIN` 配置的地址。除订阅接口外，业务接口均位于 `/api` 下。

### 数据格式

- 请求和响应默认使用 JSON，发送 JSON 时设置 `Content-Type: application/json`
- 支付宝异步通知使用表单数据，不使用 JSON
- 时间字段均为 Unix 时间戳，单位为秒
- 金额字段以分为单位，例如 `price_cents: 990` 表示 `¥9.90`
- 流量和配额以字节为单位
- 比例字段以基点为单位，例如 `commission_bps: 1500` 表示 `15%`
- 数据库实体响应多使用 `snake_case`，少量聚合或即时响应使用 `camelCase`

### 通用错误

JSON 接口失败时通常返回：

```json
{
  "error": "错误说明"
}
```

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| `400` | 请求格式或业务参数无效 |
| `401` | 未登录、会话过期或节点令牌无效 |
| `403` | 账号、角色或资源状态不允许当前操作 |
| `404` | 资源不存在 |
| `409` | 资源状态冲突，例如重复初始化或邀请已使用 |
| `429` | 登录尝试过于频繁 |
| `500` | 未预期的服务端错误 |

调用方应同时检查 HTTP 状态码和 `error` 字段，不要依赖错误文本做程序分支。

## 2. 认证与跨域

BoardLess 有三种访问凭据：

| 场景 | 凭据 | 传递方式 |
| --- | --- | --- |
| 用户、管理员、站长 API | 会话 Cookie | `boardless_session`，由登录接口设置 |
| 节点 API | 节点令牌 | `Authorization: Bearer <node-token>` |
| 客户端订阅 | 签名订阅令牌 | `/sub/<token>?target=<format>` |

### 浏览器会话

登录成功后，服务端设置 `boardless_session` Cookie：

- `HttpOnly`
- `SameSite=Lax`
- HTTPS 环境下启用 `Secure`
- 有效期 14 天

浏览器请求必须携带凭据：

```ts
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
```

使用 `curl` 调试时可通过 Cookie Jar 保存会话：

```bash
curl -c cookies.txt -X POST http://localhost:5173/api/auth/login \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' \
  -d '{"email":"owner@example.com","password":"your-password","portal":"admin"}'

curl -b cookies.txt http://localhost:5173/api/me
```

### Origin 与 CORS

浏览器跨域请求只允许 `APP_ORIGIN`，并允许发送 Cookie。所有修改数据的浏览器请求都会校验 `Origin`；前端站点的来源必须与 `APP_ORIGIN` 一致。

非浏览器服务端调用可以不发送 `Origin`。如主动设置该请求头，则必须使用正确来源。

### 角色范围

| 路径前缀 | 要求 |
| --- | --- |
| `/api/app/*` | 任意已登录用户 |
| `/api/admin/*` | 具有 `admin` 角色 |
| `/api/owner/*` | 具有 `owner` 角色 |
| `/api/node/v1/*` | 有效节点令牌 |

管理员和站长账号也同时具有 `user` 角色，因此可访问用户接口。

## 3. 公共与认证接口

### 健康检查

```http
GET /api/health
```

```json
{
  "ok": true,
  "time": 1789693200
}
```

### 首次创建站长

```http
POST /api/setup/bootstrap
```

```json
{
  "secret": "BOOTSTRAP_SECRET 的值",
  "email": "owner@example.com",
  "password": "至少 10 位，最多 128 位"
}
```

成功返回 `201`：

```json
{
  "ok": true,
  "id": "usr_..."
}
```

该接口仅能成功一次。已存在站长时返回 `409`。

### 登录

```http
POST /api/auth/login
```

```json
{
  "email": "user@example.com",
  "password": "your-password",
  "portal": "user"
}
```

`portal` 可取 `user` 或 `admin`。使用 `admin` 时，账号必须具有管理员或站长角色。

```json
{
  "user": {
    "id": "usr_...",
    "email": "user@example.com",
    "roles": ["user"],
    "status": "active",
    "inviterAdminId": "usr_..."
  }
}
```

同一 IP 和邮箱组合在 15 分钟窗口内最多尝试 10 次。登录成功后计数清除。

### 当前用户与退出

```http
GET /api/me
POST /api/auth/logout
```

`GET /api/me` 返回与登录相同的 `user` 对象。退出成功返回 `{ "ok": true }`。

### 接受邀请

```http
GET /api/invitations/:token
POST /api/invitations/:token/accept
```

查询邀请返回：

```json
{
  "role": "user",
  "expiresAt": 1789693200,
  "inviterEmail": "admin@example.com"
}
```

接受邀请请求：

```json
{
  "email": "new-user@example.com",
  "password": "至少 10 位"
}
```

成功后创建账号、直接建立会话并返回 `201`。邀请令牌只能使用一次。

## 4. 用户接口

以下接口均要求登录。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/app/dashboard` | 当前套餐、当月流量、钱包余额和订单数 |
| `GET` | `/api/app/plans` | 可购买套餐列表 |
| `GET` | `/api/app/orders` | 最近 100 条订单 |
| `POST` | `/api/app/orders` | 创建订单 |
| `GET` | `/api/app/orders/:id` | 查询自己的订单 |
| `POST` | `/api/app/orders/:id/query` | 主动向支付宝查询订单 |
| `GET` | `/api/app/usage` | 最近 12 个月流量 |
| `GET` | `/api/app/subscription` | 获取订阅地址及支持格式 |
| `POST` | `/api/app/subscription/rotate` | 轮换订阅令牌 |

### 概览

```http
GET /api/app/dashboard
```

```json
{
  "entitlement": {
    "id": "ent_...",
    "plan_name": "标准套餐",
    "starts_at": 1789693200,
    "ends_at": 1792285200,
    "quota_bytes": 107374182400,
    "status": "active"
  },
  "usage": {
    "up_bytes": 1024,
    "down_bytes": 4096
  },
  "walletCents": 0,
  "orderCount": 1
}
```

没有有效套餐时 `entitlement` 为 `null`。

### 套餐列表

```http
GET /api/app/plans
```

```json
{
  "plans": [
    {
      "id": "plan_...",
      "name": "标准套餐",
      "description": "100 GB / 30 天",
      "price_cents": 990,
      "duration_days": 30,
      "quota_bytes": 107374182400,
      "node_pool_bps": 3000,
      "status": "active",
      "node_count": 3
    }
  ]
}
```

### 创建和跟踪订单

```http
POST /api/app/orders
```

```json
{
  "planId": "plan_..."
}
```

需要支付时返回 `201`：

```json
{
  "orderId": "ord_...",
  "status": "pending",
  "cashCents": 990,
  "walletCents": 0,
  "upgradeCredit": 0,
  "expiresAt": 1789694100,
  "qrImage": "data:image/png;base64,..."
}
```

订单有效期为 15 分钟。若钱包和升级折算足以覆盖金额，会直接返回 `status: "paid"`，且没有二维码。

前端可每 3 秒左右请求 `GET /api/app/orders/:id` 更新状态，也可由用户触发：

```http
POST /api/app/orders/:id/query
```

订单状态包括：

```text
pending | paid | expired | cancelled | review
```

创建新订单会取消该用户之前仍为 `pending` 的订单。同套餐购买视为续费，不同套餐视为升级并按剩余时间折算余额。

### 订阅链接

```http
GET /api/app/subscription
```

```json
{
  "active": true,
  "baseUrl": "https://panel.example.com/sub/<token>",
  "targets": ["clash", "singbox", "surge", "base64"]
}
```

客户端实际请求格式：

```text
路由定义：/sub/:token

GET /sub/<token>?target=clash
GET /sub/<token>?target=singbox
GET /sub/<token>?target=surge
GET /sub/<token>?target=base64
```

省略 `target` 时默认为 `clash`。订阅响应包含：

```http
Cache-Control: no-store, private
Subscription-Userinfo: upload=<当月已用>; download=0; total=<套餐配额>
```

Surge 仅输出 Shadowsocks 和 Trojan；被跳过的节点名称会写入 `X-BoardLess-Skipped`。

轮换令牌：

```http
POST /api/app/subscription/rotate
```

返回 `{ "ok": true }`，此前所有订阅链接立即失效。

## 5. 管理员接口

以下接口要求 `admin` 角色，且资源范围限定为当前管理员自己的节点和受邀用户。

| 方法 | 路径 | 请求体或用途 |
| --- | --- | --- |
| `GET` | `/api/admin/overview` | 节点、用户、收益和提现概览 |
| `GET` | `/api/admin/nodes` | 自有节点列表 |
| `POST` | `/api/admin/nodes` | `{ name, protocol, config }` |
| `PATCH` | `/api/admin/nodes/:id` | `{ name?, config?, archive? }` |
| `POST` | `/api/admin/nodes/:id/rotate-token` | 轮换节点令牌 |
| `GET` | `/api/admin/invitations` | 最近 100 条邀请 |
| `POST` | `/api/admin/invitations` | `{ expiresHours? }`，邀请用户 |
| `GET` | `/api/admin/users` | 受邀用户列表 |
| `PATCH` | `/api/admin/users/:id` | `{ status: "active" | "disabled" }` |
| `GET` | `/api/admin/earnings` | 收益明细和可提现余额 |
| `GET` | `/api/admin/withdrawals` | 提现记录 |
| `POST` | `/api/admin/withdrawals` | `{ amountCents, alipayAccount }` |

### 创建节点

```json
{
  "name": "香港 01",
  "protocol": "vless",
  "config": {
    "server": "hk.example.com",
    "port": 443,
    "transport": "tcp",
    "tls": true,
    "sni": "hk.example.com"
  }
}
```

管理员创建的节点初始状态为 `pending`。成功响应中的 `token` 只显示一次：

```json
{
  "node": {
    "id": "node_...",
    "name": "香港 01",
    "protocol": "vless",
    "status": "pending",
    "config": {}
  },
  "token": "一次性显示的节点令牌"
}
```

编辑节点后会重新变为 `pending`，需要站长审核。轮换令牌后旧令牌立即失效。

### 邀请用户

```http
POST /api/admin/invitations
```

```json
{
  "expiresHours": 72
}
```

有效期会限制在 1 至 168 小时。响应包含 `id`、`token`、`expiresAt` 和可直接分享的 `url`。

### 申请提现

```http
POST /api/admin/withdrawals
```

```json
{
  "amountCents": 10000,
  "alipayAccount": "account@example.com"
}
```

最低提现金额为 `10000` 分，即 ¥100。提交后金额立即从可提现余额中冻结。

## 6. 站长接口

以下接口要求 `owner` 角色。

| 方法 | 路径 | 请求体或用途 |
| --- | --- | --- |
| `GET` | `/api/owner/overview` | 全站统计 |
| `GET` | `/api/owner/nodes` | 全站节点列表 |
| `POST` | `/api/owner/nodes` | 创建站长自有节点 |
| `PATCH` | `/api/owner/nodes/:id` | 编辑或归档站长自有节点 |
| `POST` | `/api/owner/nodes/:id/rotate-token` | 轮换站长自有节点令牌 |
| `POST` | `/api/owner/nodes/:id/action` | `{ action: "approve" | "suspend" }` |
| `GET` | `/api/owner/plans` | 全部套餐 |
| `POST` | `/api/owner/plans` | 创建套餐 |
| `PATCH` | `/api/owner/plans/:id` | 更新套餐完整配置 |
| `GET` | `/api/owner/users` | 全站账号，最多 500 条 |
| `PATCH` | `/api/owner/users/:id` | `{ status?, commissionBps? }` |
| `POST` | `/api/owner/invitations` | 创建管理员邀请 |
| `GET` | `/api/owner/orders` | 最近 500 条订单 |
| `GET` | `/api/owner/withdrawals` | 全部提现申请 |
| `POST` | `/api/owner/withdrawals/:id/action` | 确认或驳回提现 |
| `GET` | `/api/owner/audit` | 最近 500 条审计日志 |

站长创建的节点直接为 `approved`。但站长只能编辑、归档和轮换自己创建的节点；可通过 `action` 接口审核或停用任意节点。

### 创建套餐

```http
POST /api/owner/plans
```

```json
{
  "name": "标准套餐",
  "description": "100 GB / 30 天",
  "priceCents": 990,
  "durationDays": 30,
  "quotaBytes": 107374182400,
  "nodePoolBps": 3000,
  "nodeIds": ["node_..."]
}
```

- `priceCents` 可以为 `0`
- `durationDays` 和 `quotaBytes` 必须大于 `0`
- `nodePoolBps` 范围为 `0` 至 `10000`
- `nodeIds` 只能包含已审核节点

更新套餐使用相同字段，并可附加：

```json
{
  "status": "active"
}
```

`PATCH /api/owner/plans/:id` 是完整更新：未包含在 `nodeIds` 中的原有节点会被移除。

### 管理账号

```http
PATCH /api/owner/users/:id
```

```json
{
  "status": "active",
  "commissionBps": 1500
}
```

`commissionBps` 只对管理员档案生效。站长不能停用自己的账号。

### 处理提现

确认已线下转账：

```json
{
  "action": "paid",
  "transferReference": "支付宝流水号"
}
```

驳回并释放冻结金额：

```json
{
  "action": "reject"
}
```

## 7. 节点 Agent 接入

节点接口使用创建节点时返回的令牌：

```http
Authorization: Bearer <node-token>
```

令牌不会再次明文返回，必须在创建或轮换时立即安全保存。更完整的节点说明见 [`docs/node-api.md`](docs/node-api.md)。

### 推荐工作循环

1. 启动时调用配置接口，生成本地代理服务配置
2. 每 30 至 60 秒发送心跳
3. 定期拉取配置；当 `updatedAt` 变化时重新加载代理服务
4. 按固定周期聚合用户增量流量，每批不超过 40 位用户
5. 上报失败时使用相同 `reportId` 重试，成功后再清除本地增量

### 拉取配置

```http
GET /api/node/v1/config
Authorization: Bearer <node-token>
```

```json
{
  "node": {
    "id": "node_...",
    "name": "香港 01",
    "protocol": "vless",
    "status": "approved",
    "config": {
      "server": "hk.example.com",
      "port": 443
    },
    "updatedAt": 1789693200
  },
  "users": [
    {
      "id": "usr_...",
      "uuid": "...",
      "secret": "...",
      "expiresAt": 1792285200,
      "quotaBytes": 107374182400,
      "usedBytes": 5120
    }
  ],
  "generatedAt": 1789693200
}
```

只有 `approved` 节点会收到用户列表。Agent 应把 `users` 当作当前授权快照：不在新快照中的用户应从代理服务移除。

### 心跳

```http
POST /api/node/v1/heartbeat
Authorization: Bearer <node-token>
Content-Type: application/json
```

```json
{
  "onlineCount": 12,
  "version": "agent/1.0.0"
}
```

```json
{
  "ok": true,
  "serverTime": 1789693200,
  "status": "approved"
}
```

`onlineCount` 会被限制在 `0` 至 `1000000`，`version` 最多保存 80 个字符。

### 上报增量流量

```http
POST /api/node/v1/usage
Authorization: Bearer <node-token>
Content-Type: application/json
```

```json
{
  "reportId": "hk01-20260918T120000Z-00042",
  "entries": [
    {
      "userId": "usr_...",
      "upBytes": 1024,
      "downBytes": 4096
    }
  ]
}
```

首次接收：

```json
{
  "accepted": true,
  "entries": 1
}
```

重复报告：

```json
{
  "accepted": false,
  "duplicate": true
}
```

接入规则：

- `reportId` 在单个节点内必须唯一，最长 120 字符
- `entries` 每批最多 40 条
- `upBytes` 和 `downBytes` 是自上次成功报告后的增量，不是累计计数器
- 字节数必须为非负安全整数，且上下行总和不能为 0
- 无有效套餐或不属于该节点套餐的用户条目会被忽略
- 仅 `approved` 节点可以上报流量
- 网络超时或响应不确定时，必须使用原 `reportId` 重试以保证幂等
- `accepted: true` 时，`entries` 是实际计入的有效条目数

## 8. 后端一键配置与安装规范

这里的“前端”指 BoardLess 控制面整体。浏览器页面只负责操作界面；节点后端必须通过 BoardLess API 获取用户信息，不能直接从浏览器、GitHub README 或本地静态文件生成用户。

### 用户数据的唯一来源

节点后端的用户授权信息必须全部来自：

```http
GET /api/node/v1/config
Authorization: Bearer <node-token>
```

以下字段均由 BoardLess 控制面生成和维护：

- 用户 ID：`users[].id`
- 协议 UUID：`users[].uuid`
- 协议密码或密钥：`users[].secret`
- 套餐到期时间：`users[].expiresAt`
- 自然月配额：`users[].quotaBytes`
- 自然月已用流量：`users[].usedBytes`

节点后端必须遵守以下规则：

1. 不提供独立的用户创建、删除、续期或改密入口
2. 每次拉取的 `users` 都视为当前完整授权快照，而不是增量列表
3. 新快照中不存在的用户必须从代理服务配置中移除
4. 本地可以短期缓存上一次成功快照用于故障恢复，但缓存不是用户数据源
5. 节点不得自行延长 `expiresAt`、扩大 `quotaBytes` 或修改凭据
6. 本地产生的上下行增量通过 `/api/node/v1/usage` 回传 BoardLess
7. `pending`、`suspended` 节点收到空用户列表时，应停止对所有用户授权
8. 节点令牌失效或节点被归档时，应停止同步并提示重新绑定，不能继续永久使用旧缓存

因此，完整数据流应为：

```text
用户在 BoardLess 注册/购买
        ↓
BoardLess 数据库计算有效套餐、配额和凭据
        ↓
节点后端通过 /api/node/v1/config 拉取完整用户快照
        ↓
节点后端生成代理服务配置并热重载
        ↓
节点后端通过 /api/node/v1/usage 回传流量增量
```

### 两类一键安装

本项目需要区分两个完全不同的安装对象：

| 对象 | 安装位置 | 用途 |
| --- | --- | --- |
| BoardLess 面板 | 控制面服务器 | 提供 Web、API、数据库和支付能力 |
| 节点后端 | 每台节点服务器 | 运行 Agent、代理程序，同步用户并上报流量 |

两种脚本必须分开维护。面板安装脚本不能携带节点令牌；节点安装脚本也不能获得站长会话、数据库或支付宝密钥。

### 先导入后端 GitHub 仓库

BoardLess 不预置某个固定节点后端。站长应先在控制台输入后端 GitHub 仓库地址，将兼容后端导入面板：

```text
https://github.com/<OWNER>/<BACKEND_REPO>
```

导入流程：

1. 站长填写仓库 URL，可选填写分支、标签或提交 SHA；默认读取仓库默认分支
2. BoardLess 服务端解析为严格的 `owner/repository`，不接受任意下载域名
3. 服务端通过 GitHub API 解析本次导入对应的不可变提交 SHA
4. 服务端读取该提交中的 `README.md`
5. 检查 README 是否包含 BoardLess 后端特征识别码
6. 解析识别块中的结构化元数据和配置预设
7. 校验脚本路径、哈希、协议配置和 API 兼容版本
8. 向站长展示仓库、提交 SHA、后端名称、权限需求和预设列表
9. 站长确认后才保存为“已导入后端”；导入不代表节点立即获得信任

私有仓库可以在未来通过服务器端 GitHub 凭据读取，但凭据不得发送给浏览器或节点服务器。

### 后端仓库特征识别码

兼容后端必须在 README 中包含固定特征码：

```markdown
<!-- BOARDLESS_BACKEND_REPOSITORY_V1 -->
```

固定特征码只用于确认“该仓库主动声明兼容 BoardLess”，不能代替安全审核。README 还必须包含唯一的结构化识别块：

````markdown
<!-- BOARDLESS_BACKEND_REPOSITORY_V1 -->

<!-- boardless:backend:start -->
```json boardless-backend
{
  "recognitionCode": "BOARDLESS_BACKEND_REPOSITORY_V1",
  "schemaVersion": 1,
  "backendId": "com.example.boardless-agent",
  "name": "Example BoardLess Agent",
  "version": "1.0.0",
  "panelApiVersion": "v1",
  "install": {
    "script": "scripts/install.sh",
    "sha256": "replace-with-64-character-sha256",
    "uninstallScript": "scripts/uninstall.sh"
  },
  "presets": [
    {
      "id": "vless-reality",
      "name": "VLESS Reality",
      "protocol": "vless",
      "description": "TCP + Reality 的推荐配置",
      "config": {
        "server": "{{ input.server }}",
        "port": 443,
        "transport": "tcp",
        "tls": true,
        "sni": "{{ input.sni }}",
        "flow": "xtls-rprx-vision",
        "realityPublicKey": "{{ generated.realityPublicKey }}",
        "shortId": "{{ generated.shortId }}"
      },
      "requiredInputs": ["server", "sni"],
      "generatedOutputs": ["realityPublicKey", "shortId"]
    }
  ]
}
```
<!-- boardless:backend:end -->
````

字段约定：

| 字段 | 说明 |
| --- | --- |
| `recognitionCode` | 必须精确等于 README 中的固定特征码 |
| `schemaVersion` | 识别块结构版本，当前规划为 `1` |
| `backendId` | 后端永久唯一 ID，发布后不可随意更换 |
| `panelApiVersion` | 该后端支持的 BoardLess 节点 API 版本 |
| `install.script` | 仓库内节点安装脚本的相对路径 |
| `install.sha256` | 对应提交中安装脚本的 SHA-256 |
| `presets` | 后端官方维护的节点配置范例 |
| `requiredInputs` | 管理员在面板中必须填写的字段 |
| `generatedOutputs` | 安装时在节点服务器生成并回传的公开字段 |

私钥只能保存在节点服务器。`generatedOutputs` 只能包含公钥、Short ID、公开端口等可公开配置，不能上传 Reality 私钥或其他服务端秘密。

### README 读取与重新同步规则

README 必须由 BoardLess 服务端读取，浏览器不直接请求或解析 GitHub 内容：

1. 只解析 `boardless:backend:start` 和 `boardless:backend:end` 之间的 `boardless-backend` JSON
2. 特征码、`recognitionCode`、`backendId`、Schema 和 API 版本必须全部匹配
3. 仓库 URL、README URL、安装脚本 URL 必须指向同一 GitHub 仓库
4. README 和安装脚本必须固定到同一个提交 SHA
5. 所有相对路径规范化后不得逃出仓库，禁止 `../` 和外部 URL
6. 校验协议、模板变量、必填输入、生成字段和脚本 SHA-256
7. 保存仓库 ID、`backendId`、提交 SHA、读取时间、内容哈希和同步状态
8. 同一个 `backendId` 不能被另一仓库静默覆盖；仓库转移需站长显式确认
9. README 中的 HTML、JavaScript 和 Shell 内容只作为文本展示，绝不在面板服务器执行
10. GitHub 暂时不可用时可以读取最后一次成功缓存，但必须标明缓存提交 SHA

重新同步时先生成差异预览。安装脚本、权限要求、预设或 `backendId` 变化时，必须再次由站长确认，不能自动信任更新后的 `main`。

### 后端仓库接口

以下接口已经实现：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/owner/backends` | 列出已导入的后端仓库与同步状态 |
| `POST` | `/api/owner/backends/import` | 读取仓库 README，验证特征码并返回导入预览 |
| `POST` | `/api/owner/backends/:id/confirm` | 确认首次导入或高风险更新 |
| `POST` | `/api/owner/backends/:id/sync` | 按指定 ref 重新同步并生成差异 |
| `PATCH` | `/api/owner/backends/:id` | 启用或停用已确认后端；切换 ref 使用同步接口 |
| `GET` | `/api/admin/node-presets` | 返回已启用后端的配置预设 |
| `POST` | `/api/admin/nodes/from-preset` | 根据后端预设和输入创建待安装节点 |
| `POST` | `/api/admin/nodes/:id/install-command` | 生成短期有效的一次性节点安装命令 |
| `POST` | `/api/node/v1/bootstrap` | Agent 首次启动时兑换安装令牌并提交公开配置 |

导入预览请求示例：

```json
{
  "repositoryUrl": "https://github.com/example/boardless-agent",
  "ref": "v1.0.0",
  "readmePath": "README.md"
}
```

服务端响应应包含解析后的提交 SHA、识别码、后端信息、预设摘要、脚本哈希验证结果和风险提示，但不得直接导入或执行脚本。

### 使用后端预设一键配置节点

管理员只能从站长已经导入并启用的后端中选择预设：

```json
{
  "backendId": "com.example.boardless-agent",
  "presetId": "vless-reality",
  "name": "香港 01",
  "inputs": {
    "server": "hk.example.com",
    "sni": "www.example.com"
  }
}
```

配置流程：

1. BoardLess 展示 README 中已校验的 `requiredInputs` 表单
2. 服务端合并预设和管理员输入，浏览器不能自行生成最终配置
3. 没有 `generatedOutputs` 时直接执行现有 `validateNodeConfig`
4. 存在安装阶段输出时，先校验已知字段并保持节点为 `pending`
5. BoardLess 为该节点签发 5 分钟内单次有效的安装令牌
6. 目标服务器安装脚本生成 Reality 密钥等本机数据
7. Agent 通过 `/api/node/v1/bootstrap` 提交公钥等 `generatedOutputs` 并兑换正式节点令牌
8. BoardLess 合并公开输出并执行完整 `validateNodeConfig`
9. 管理员节点等待站长审核；审核通过且加入套餐后才会收到用户

“一键配置”只配置节点运行参数，不得在 BoardLess 数据库之外创建用户。

### 节点后端 Bash 安装参数

已导入的后端仓库必须提供非交互式安装脚本，至少支持：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--panel-url` | 是 | BoardLess 的公开 HTTPS 地址 |
| `--install-token` | 是 | 5 分钟内单次有效的节点安装令牌 |
| `--preset` | 是 | 已选 README 预设 ID |
| `--agent-version` | 否 | 固定安装的 Agent 版本 |
| `--install-dir` | 否 | 安装目录 |
| `--service-name` | 否 | systemd 服务名 |
| `--unattended` | 否 | 禁止交互，参数不足时直接失败 |

示例：

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/<OWNER>/<BACKEND_REPO>/<COMMIT_SHA>/scripts/install.sh' \
  -o /tmp/boardless-node-install.sh

echo '<EXPECTED_SHA256>  /tmp/boardless-node-install.sh' | sha256sum -c -

sudo bash /tmp/boardless-node-install.sh \
  --panel-url 'https://panel.example.com' \
  --install-token '<ONE_TIME_INSTALL_TOKEN>' \
  --preset 'vless-reality' \
  --agent-version '1.0.0' \
  --install-dir '/opt/boardless-agent' \
  --service-name 'boardless-agent' \
  --unattended
```

节点安装脚本应检查系统与架构、安装固定版本、生成本机密钥、完成 bootstrap、保存正式节点令牌、注册 systemd、发送首次心跳，并在重复执行时安全更新。失败必须返回非零退出码。

### BoardLess 面板一键安装脚本

仓库已提供可执行的 [`scripts/install-panel.sh`](https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh)，这是自托管的首选安装方式。直接执行且不传参数时进入交互向导，逐项询问安装目录、域名、HTTPS、站长账号与密码和支付宝配置。它也可从指定 GitHub 仓库和固定版本获取源码。

当前支持的面板安装参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--domain` | 无人值守时 | 面板最终访问域名，用于生成 `APP_ORIGIN` |
| `--source-dir` | 否 | 本地 BoardLess 源码目录；默认使用脚本所在仓库 |
| `--repository` | 远程安装时 | BoardLess GitHub HTTPS 仓库地址 |
| `--version` | 远程安装时 | 固定安装的 BoardLess Release、ref 或提交 SHA |
| `--install-dir` | 否 | 默认 `/opt/boardless` |
| `--data-dir` | 否 | 默认 `/var/lib/boardless`，存放 SQLite 和备份 |
| `--listen-port` | 否 | 默认 `3000` |
| `--with-caddy` | 否 | 安装并配置 Caddy HTTPS 反向代理 |
| `--acme-email` | 启用 HTTPS 时 | 证书通知邮箱 |
| `--env-file` | 否 | 合并预先准备的支付宝等环境变量文件 |
| `--owner-email` | 无人值守首次安装时 | 自动创建的站长邮箱 |
| `--owner-password-file` | 无人值守首次安装时 | 从仅 root 可读文件载入站长密码 |
| `--skip-bootstrap` | 否 | 跳过自动创建站长账号 |
| `--unattended` | 否 | 无交互安装，缺少参数时直接失败 |

推荐的远程交互安装（也是 README 的 Linux 快速开始形式）：

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh' \
  -o /tmp/boardless-panel-install.sh && \
sudo bash /tmp/boardless-panel-install.sh \
  --repository 'https://github.com/matthewlu070111/BoardLess.git' \
  --version 'refs/heads/main'
```

该命令会下载后再执行，而不是使用 `curl | sudo bash`，从而保留标准输入供域名、HTTPS、站长账号密码与支付宝配置的交互询问。安装程序随后会把 `refs/heads/main` 解析并记录为本次实际安装的提交 SHA；正式发布仍建议将 `--version` 换成 Release 标签或提交 SHA。

从远程仓库安装：

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/install-panel.sh' \
  -o /tmp/boardless-panel-install.sh

echo '<EXPECTED_SHA256>  /tmp/boardless-panel-install.sh' | sha256sum -c -

sudo bash /tmp/boardless-panel-install.sh \
  --repository 'https://github.com/matthewlu070111/BoardLess.git' \
  --domain 'panel.example.com' \
  --version '<RELEASE_TAG>' \
  --install-dir '/opt/boardless' \
  --data-dir '/var/lib/boardless' \
  --with-caddy \
  --acme-email 'admin@example.com' \
  --unattended
```

面板脚本当前会：

1. 检查 Linux、权限、端口、Docker 和 Docker Compose
2. 安装缺少的受支持依赖，或给出明确错误
3. 从本地源码或指定的 GitHub ref 准备构建目录；远程 ref 会解析并显示实际提交 SHA
4. 自动生成 `SESSION_SECRET` 和 `BOOTSTRAP_SECRET`，权限设为仅 root 可读
5. 写入 `APP_ORIGIN=https://<domain>` 和用户提供的环境变量
6. 创建持久化数据目录和备份目录，不覆盖已有数据库
7. 启动服务并等待 `/api/health` 成功
8. 通过容器内部 API 自动创建首次站长账号，密码不出现在命令行参数或日志中
9. 安装 `boardlessctl`，提供启动、停止、重启、状态和日志命令
10. 重复执行时识别已有安装，停止服务完成 SQLite 一致性备份后再升级

不使用 `--with-caddy` 时，脚本只映射 `--listen-port`，需要自行配置 HTTPS 反向代理。脚本不会自动打开防火墙，不会把支付宝私钥或初始化密钥上传到外部服务，也不会在终端直接打印密钥。

### Cloudflare 一键部署

README 的首选入口应使用 Cloudflare 官方部署按钮：

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fmatthewlu070111%2FBoardLess)
```

Cloudflare 将读取 `wrangler.jsonc` 自动创建并绑定 D1，并使用 `package.json` 中的 `deploy` 命令执行数据库迁移和 Worker 发布。

### Cloudflare 一键部署脚本（高级方式）

仓库还提供 [`scripts/deploy-cloudflare.sh`](https://raw.githubusercontent.com/matthewlu070111/BoardLess/refs/heads/main/scripts/deploy-cloudflare.sh)，用于需要交互配置、自定义域名和自动初始化站长账号的高级部署场景：

```bash
bash scripts/deploy-cloudflare.sh
```

交互向导会询问 Worker 名称、D1 名称、最终 HTTPS 地址、Custom Domain、站长邮箱与密码和支付宝配置。脚本随后完成：

1. 检查 Node.js 22.12+、npm、OpenSSL 和 Cloudflare 身份认证
2. 安装锁定版本的 npm 依赖
3. 更新 `wrangler.jsonc` 中的 Worker 名称、`APP_ORIGIN` 和支付宝网关
4. 创建或复用 D1 数据库
5. 生成并上传 `SESSION_SECRET`、`BOOTSTRAP_SECRET` 和支付宝 Secrets
6. 执行远程数据库迁移
7. 构建并部署 Worker，按需绑定 Custom Domain
8. 等待公开地址可访问并创建首次站长账号

首次生成的 Secrets 保存在被 Git 忽略的 `.cloudflare.secrets.json`，权限设为 `0600`。后续重复部署会复用该文件，避免轮换 `SESSION_SECRET` 导致所有会话和订阅链接失效。该文件属于生产密钥备份，必须妥善保存，不能提交到仓库。

无人值守部署示例：

```bash
bash scripts/deploy-cloudflare.sh \
  --worker-name boardless \
  --database-name boardless \
  --origin 'https://panel.example.com' \
  --custom-domain \
  --owner-email 'owner@example.com' \
  --owner-password-file '/secure/boardless-owner-password' \
  --unattended
```

支付宝参数可以通过 `--alipay-app-id`、`--alipay-private-key`、`--alipay-public-key` 和 `--alipay-sandbox` 提供。运行 `bash scripts/deploy-cloudflare.sh --help` 查看完整参数。

### 两类安装脚本的共同安全要求

- 节点后端安装命令必须固定到导入时校验过的提交 SHA；面板 README 按指定要求从 `main` 下载入口脚本，但入口脚本会记录实际安装的源码提交，生产发布仍推荐 Release 标签或提交 SHA
- 下载到本地后校验 SHA-256，再使用 `sudo bash` 执行
- 脚本启用 `set -euo pipefail`，每一步失败返回非零退出码
- 敏感令牌、密钥和密码不得写入审计日志、终端调试输出或分析系统
- 安装操作记录版本和提交 SHA，但不记录秘密值
- 安装脚本提供幂等更新、明确回滚和默认保留数据的卸载方式
- 节点仓库必须由站长导入并确认；普通管理员不能通过任意 URL 执行脚本
- README 发生高风险变化后，旧的确认状态失效，必须重新审核

### 后端 README 最低要求

要被 BoardLess 成功识别和导入，后端仓库 README 至少应包含：

- `BOARDLESS_BACKEND_REPOSITORY_V1` 固定特征识别码
- 唯一 `backendId` 和 `boardless-backend` JSON 识别块
- 支持的操作系统和 CPU 架构
- Agent、代理程序与 BoardLess API 的版本兼容性
- 一个或多个配置预设及其输入、生成输出
- 节点 `install.sh` 的非交互参数和 SHA-256
- 安装目录、配置文件和 systemd 服务位置
- 所需端口、防火墙和域名要求
- 更新、回滚和卸载方式
- 用户同步、心跳和流量上报行为

## 9. 节点协议配置

所有协议共享：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `server` | `string` | 必填，服务器地址 |
| `port` | `integer` | 必填，`1-65535` |
| `udp` | `boolean` | 可选，默认 `true` |

### Shadowsocks

```json
{
  "server": "ss.example.com",
  "port": 8388,
  "udp": true,
  "method": "aes-256-gcm",
  "plugin": "v2ray-plugin",
  "pluginOpts": "server;tls;host=ss.example.com"
}
```

支持的 `method`：

```text
aes-128-gcm
aes-256-gcm
chacha20-ietf-poly1305
2022-blake3-aes-128-gcm
2022-blake3-aes-256-gcm
```

### VMess / VLESS / Trojan

三者支持 `tcp`、`ws`、`grpc` 传输：

```json
{
  "server": "edge.example.com",
  "port": 443,
  "transport": "ws",
  "path": "/ws",
  "host": "edge.example.com",
  "serviceName": "grpc-service"
}
```

额外字段：

| 协议 | 字段 |
| --- | --- |
| VMess | `tls`、`sni`、`alterId`（默认 `0`，范围 `0-64`） |
| VLESS | `tls`、`sni`、`flow`、`realityPublicKey`、`shortId` |
| Trojan | `sni`、`skipCertVerify` |

### Hysteria 2

```json
{
  "server": "hy2.example.com",
  "port": 443,
  "sni": "hy2.example.com",
  "obfs": "salamander",
  "obfsPassword": "password",
  "upMbps": 100,
  "downMbps": 100,
  "insecure": false
}
```

### TUIC

```json
{
  "server": "tuic.example.com",
  "port": 443,
  "sni": "tuic.example.com",
  "congestionControl": "bbr",
  "udpRelayMode": "native",
  "insecure": false
}
```

## 10. 支付宝回调

异步通知地址：

```text
POST /api/payments/alipay/notify
```

该接口由支付宝直接调用，提交支付宝标准表单字段。服务端会验证：

- 支付宝 RSA 签名
- `app_id` 与配置一致
- `trade_status` 为 `TRADE_SUCCESS` 或 `TRADE_FINISHED`
- `out_trade_no` 对应本地订单
- `total_amount` 与订单现金支付金额一致
- `notify_id` 或交易状态事件未被处理过

处理成功或无需处理时返回纯文本：

```text
success
```

验证失败返回 `400` 和：

```text
failure
```

回调地址必须可通过公网 HTTPS 访问。不要在反向代理层把表单请求体改写为 JSON。

## 11. 接入检查清单

### Web 前端

- 所有会话请求设置 `credentials: "include"`
- 修改请求携带正确 `Origin`
- 金额、比例、流量和 Unix 秒时间戳按约定转换后展示
- 对 `401` 跳转登录，对 `403` 显示权限或状态提示
- 创建订单后兼容 `pending` 和直接 `paid` 两种响应
- 不在日志或监控中记录 Cookie、邀请令牌、节点令牌和订阅令牌

### 节点 Agent

- 创建节点后立即保存令牌
- 用户、凭据、套餐期限与配额只接受 BoardLess 配置接口下发的数据
- 不在节点服务器提供绕过 BoardLess 的本地用户管理入口
- 把配置接口返回的用户列表作为完整快照处理
- 只上报流量增量
- 为每批报告生成可持久化的唯一 `reportId`
- 超时重试时复用 `reportId`
- 处理 `pending`、`suspended` 和 `archived` 状态

### 一键配置与安装

- 导入时要求 README 同时具有 `BOARDLESS_BACKEND_REPOSITORY_V1` 特征码和唯一 `backendId`
- 只同步站长已经确认并启用的后端 GitHub 仓库
- README 识别块必须通过固定标记和 JSON Schema 校验
- 安装脚本与 README 固定到同一提交 SHA
- 预设应用后仍调用服务端协议配置校验
- 安装命令使用短期单次令牌，不把正式节点令牌持久暴露在 Shell 历史中
- 面板安装脚本与节点后端安装脚本严格分离
- 所有安装和同步操作写入不含密钥的审计日志

### 服务端部署

- `APP_ORIGIN` 与前端实际来源一致
- 反向代理保留 Cookie、`Authorization` 和支付宝表单请求体
- 全站启用 HTTPS
- 将节点令牌、支付宝密钥及 `SESSION_SECRET` 视为生产密钥管理

## 12. 当前边界

- API 尚未提供 OpenAPI/Swagger 描述
- 列表接口使用固定上限，尚无游标分页
- 后端仓库导入、README 识别、预设同步、一次性安装命令和节点 bootstrap 已实现；实际节点 Agent 与各后端的安装脚本由对应后端仓库提供
- 面板一键脚本已支持安装和带数据库备份的重复升级；自动回滚和卸载流程尚未实现
- 未实现邮件发送、自动退款和支付宝自动转账
- 节点 Agent 与代理进程不包含在本仓库中
