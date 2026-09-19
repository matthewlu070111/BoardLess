# BoardLess 节点 API

## 首次安装与令牌兑换

通过后端预设创建的节点首先获得一条 30 分钟内有效、只能使用一次的安装命令。安装脚本在节点服务器生成 README 中声明的公开字段后调用：

`POST /api/node/v1/bootstrap`

```json
{
  "installToken": "一次性安装令牌",
  "generatedOutputs": {
    "realityPublicKey": "公开密钥",
    "shortId": "公开 Short ID"
  },
  "agentVersion": "agent/1.0.0"
}
```

`generatedOutputs` 只能包含后端 README 预设已经声明的字段，不能上传私钥。成功响应包含正式 `nodeToken` 和最终协议配置：

```json
{
  "nodeId": "node_...",
  "nodeToken": "仅返回一次的正式节点令牌",
  "status": "pending",
  "config": { "server": "hk.example.com", "port": 443 }
}
```

Agent 必须以仅 root 可读权限保存正式节点令牌，之后删除安装令牌。节点仍为 `pending`，站长审核通过前不会获得任何用户。

所有节点接口使用创建节点时仅显示一次的令牌：

```http
Authorization: Bearer <node-token>
```

## 拉取配置与用户

`GET /api/node/v1/config`

返回节点协议配置和获得该节点授权的用户。站长选择“按套餐授权”时，仅返回套餐有效且自然月流量未超额的用户；选择“按用户直接授权”时，按逐个节点分配关系返回用户，不要求套餐：

```json
{
  "node": {
    "id": "node_...",
    "name": "香港 01",
    "protocol": "vless",
    "status": "approved",
    "config": { "server": "hk.example.com", "port": 443 }
  },
  "users": [
    {
      "id": "usr_...",
      "uuid": "...",
      "secret": "...",
      "expiresAt": 1790000000,
      "quotaBytes": 107374182400,
      "usedBytes": 1024
    }
  ]
}
```

直接授权模式下会额外返回 `"authorizationMode": "user"`，用户项中 `expiresAt` 与 `quotaBytes` 为 `null`，并以 `"unlimited": true` 表示不使用套餐期限及套餐流量额度。

节点端负责把 `uuid` 或 `secret` 写入实际协议服务。面板不启动或管理代理进程。

## 心跳

`POST /api/node/v1/heartbeat`

```json
{ "onlineCount": 12, "version": "agent/1.0.0" }
```

## 流量上报

`POST /api/node/v1/usage`

```json
{
  "reportId": "node-local-unique-id",
  "entries": [
    { "userId": "usr_...", "upBytes": 1024, "downBytes": 4096 }
  ]
}
```

- `reportId` 必须在该节点内唯一；重复上报不会再次计费。
- 数值是自上次成功报告后的增量，不是累计计数器。
- 每批最多 40 位用户。失败时用相同 `reportId` 重试。
- 仅已审核节点可以上报流量。

## 状态约定

- `pending`：配置待站长审核，不下发用户。
- `approved`：正常拉取用户并上报流量。
- `suspended`：站长停用，不下发用户且拒绝流量上报。
- `archived`：管理员归档，令牌不可再使用。
