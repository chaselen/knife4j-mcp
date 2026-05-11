# knife4j-mcp

一个基于 Node.js + TypeScript 的标准 MCP server（stdio），用于读取 Knife4j / Swagger 多模块接口文档，并为 Agent 提供结构化接口查询能力。

它适合这样的场景：

- 文档入口不是单个 OpenAPI spec，而是 Knife4j 聚合页
- 需要先从 `/swagger-resources` 获取模块列表
- 每个模块再去拉自己的 `/v2/api-docs`
- 文档可能受 Basic Auth 或自定义 Header 保护
- Agent 需要根据路径、关键词、tag、字段线索快速定位接口

## 使用方式

```bash
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
npx -y @chaselen/knife4j-mcp
```

如果文档受保护，也可以一起传认证信息：

```bash
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
SWAGGER_BASIC_AUTH=demo:demo \
npx -y @chaselen/knife4j-mcp
```

说明：

- 已发布到 npm，可直接通过 `npx` 启动
- 要求 Node.js >= 20
- 这是一个 stdio MCP server，通常由 MCP Client 拉起，而不是手动长期在终端里交互运行

## MCP Client 接入

这个包不只支持 Codex，也支持 Claude Code、OpenCode，以及其他支持本地 stdio MCP 的客户端。

本质上都可以抽象成下面这组启动参数：

```json
{
  "command": "npx",
  "args": ["-y", "@chaselen/knife4j-mcp"],
  "env": {
    "SWAGGER_RESOURCES_URL": "http://127.0.0.1:3301/swagger-resources",
    "SWAGGER_BASIC_AUTH": "demo:demo"
  }
}
```

### Codex CLI

```bash
codex mcp add knife4j-swagger \
  --env SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
  --env SWAGGER_BASIC_AUTH=demo:demo \
  -- npx -y @chaselen/knife4j-mcp
```

### Claude Code

CLI 添加方式：

```bash
claude mcp add knife4j-swagger \
  --env SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
  --env SWAGGER_BASIC_AUTH=demo:demo \
  -- npx -y @chaselen/knife4j-mcp
```

如果你偏好项目级配置，也可以在项目根目录放一个 `.mcp.json`：

```json
{
  "mcpServers": {
    "knife4j-swagger": {
      "command": "npx",
      "args": ["-y", "@chaselen/knife4j-mcp"],
      "env": {
        "SWAGGER_RESOURCES_URL": "http://127.0.0.1:3301/swagger-resources",
        "SWAGGER_BASIC_AUTH": "demo:demo"
      }
    }
  }
}
```

### OpenCode

在 `opencode.json` 或 `opencode.jsonc` 中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "knife4j-swagger": {
      "type": "local",
      "command": ["npx", "-y", "@chaselen/knife4j-mcp"],
      "enabled": true,
      "environment": {
        "SWAGGER_RESOURCES_URL": "http://127.0.0.1:3301/swagger-resources",
        "SWAGGER_BASIC_AUTH": "demo:demo"
      }
    }
  }
}
```

### 其他客户端

如果你的 MCP 客户端支持本地 stdio server，通常只要把下面三类信息按它自己的格式填进去即可：

- `command`: `npx`
- `args`: `["-y", "@chaselen/knife4j-mcp"]`
- `env`: `SWAGGER_RESOURCES_URL`、`SWAGGER_BASIC_AUTH`、`SWAGGER_HEADERS` 等环境变量

## 环境变量

### 必填

- `SWAGGER_RESOURCES_URL`
  - Knife4j / Swagger 聚合入口地址，用来读取模块列表。
  - 这个地址通常就是平台暴露出来的 `/swagger-resources`，例如：`http://127.0.0.1:3301/swagger-resources`
  - server 启动后会先请求它，再根据返回结果继续拉取每个模块自己的 Swagger / OpenAPI 文档。
  - 注意：这里填的不是某个单独模块的 `/v2/api-docs` 或 `/v3/api-docs`，而是“模块目录入口”。

### 可选

- `SWAGGER_BASE_URL`
  - 用于补全 `swagger-resources` 里返回的相对路径。
  - 如果模块文档地址是 `/api/user/v2/api-docs` 这种相对路径，server 会拿它和 `SWAGGER_BASE_URL` 进行拼接。
  - 未设置时，默认回退到 `SWAGGER_RESOURCES_URL` 的基址。
  - 常见场景是：`swagger-resources` 和真实文档地址不在同一个基址下，或者经过了网关改写。
- `SWAGGER_BASIC_AUTH`
  - 访问 Swagger 文档时使用的 HTTP Basic Auth 账号密码。
  - 这个值会同时用于请求 `SWAGGER_RESOURCES_URL` 和每个模块的 spec 文档。
  - 格式是 `username:password`，例如：`demo:demo`
  - 不需要带 `Basic ` 前缀，程序会自动转成 `Authorization: Basic ...` 请求头。
  - 如果你的文档地址本身不需要登录认证，可以不填。
- `SWAGGER_HEADERS`
  - 额外附带到所有文档请求上的自定义 HTTP Header。
  - 适合需要 Token、租户标识、环境标识这类网关头的场景。
  - 格式是 JSON 字符串，例如：`{"X-Env":"dev","X-Token":"abc"}`
  - 这些 Header 会和 Basic Auth 一起生效；如果两者都配置了，请求会同时带上。
- `SWAGGER_MODULE_ALLOWLIST`
  - 只加载指定模块，其他模块会被忽略。
  - 适合模块很多、只想给 Agent 暴露其中一部分接口时使用。
  - 格式为逗号分隔，例如：`sample-account,sample-auth`
  - 这里填写的名称应与 `swagger-resources` 返回的模块名一致。
- `CACHE_TTL_MS`
  - 内存缓存有效期，单位是毫秒。
  - 默认值是 `300000`，也就是 5 分钟。
  - 在缓存有效期内，查询会直接复用已加载的索引；过期后会在下次刷新时重新拉取远端文档。
- `LOG_LEVEL`
  - 日志级别。
  - 当前设为 `debug` 时会输出更多拉取和解析过程日志，便于排查文档地址、认证或 JSON 格式问题。

### 一个更完整的例子

```bash
SWAGGER_RESOURCES_URL=https://gateway.example.com/swagger-resources \
SWAGGER_BASIC_AUTH=swagger_user:swagger_password \
SWAGGER_HEADERS='{"X-Env":"prod","X-Tenant":"platform"}' \
SWAGGER_MODULE_ALLOWLIST=system-user,system-auth \
npx -y @chaselen/knife4j-mcp
```

## MCP Tools

对外只提供 4 个核心 tools：

- `list_specs`：列出模块、spec 地址、加载状态和接口数量
- `find_api`：按关键词、path、tag、module、method 搜索接口
- `get_api_detail`：获取单个接口的完整详情，并递归展开请求/响应 schema
- `refresh_specs`：强制刷新 `swagger-resources` 和所有模块 spec

## 功能

- 支持读取 Knife4j / Swagger 多模块聚合文档
- 支持 Basic Auth 和自定义 Header
- 支持 Swagger 2.0，并尽量兼容 OpenAPI 3
- 支持按路径、关键词、tag、method 等条件搜索接口
- 支持通过 `get_api_detail` 获取完整接口详情，并递归展开请求/响应 schema
- 支持模块 allowlist、缓存 TTL 和手动刷新
- 单个模块加载失败不会影响其他模块可用

## 最小可运行示例

仓库自带一个 mock 的多模块 Swagger 服务。

### 1. 启动 mock 文档服务

```bash
MOCK_SWAGGER_BASIC_AUTH=demo:demo npm run mock:swagger
```

默认地址：

- `http://127.0.0.1:3301/swagger-resources`
- `http://127.0.0.1:3301/sample-account/v2/api-docs`
- `http://127.0.0.1:3301/sample-auth/v2/api-docs`
- `http://127.0.0.1:3301/demo/sample-notify/v3/api-docs`

### 2. 构建 MCP server

```bash
npm run build
```

### 3. 运行 smoke test

```bash
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
SWAGGER_BASIC_AUTH=demo:demo \
npm run test:smoke
```

这个脚本会通过 MCP stdio client 依次调用：

- `tools/list`
- `list_specs`
- `find_api`
- `get_api_detail`

它会自动完成一次 `list_specs -> find_api -> get_api_detail` 的最小联调验证。
