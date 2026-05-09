# knife4j-mcp

一个基于 Node.js + TypeScript 的标准 MCP server（stdio），用于读取 Knife4j / Swagger 多模块接口文档，并为 Codex Agent 提供结构化接口查询能力。

它适合这样的场景：

- 文档入口不是单个 OpenAPI spec，而是 Knife4j 聚合页
- 需要先从 `/swagger-resources` 获取模块列表
- 每个模块再去拉自己的 `/v2/api-docs`
- 文档可能受 Basic Auth 或自定义 Header 保护
- Agent 需要根据路径、关键词、tag、字段线索快速定位接口

## 功能

- 启动时读取 `SWAGGER_RESOURCES_URL`
- 自动拉取 `swagger-resources` 和每个模块的 spec
- 兼容相对路径补全
- 兼容 Swagger 2.0，尽量兼容 OpenAPI 3
- 内存索引支持：
  - 完整路径查找
  - 路径片段模糊搜索
  - tag 搜索
  - summary / description / operationId 搜索
  - 返回接口所属模块
- 支持模块 allowlist
- 支持缓存 TTL 和手动刷新
- 单个模块失败不会拖垮整个服务

## MCP Tools

### `list_specs`

列出所有模块、spec 地址、加载状态、类型和接口数量。

### `find_api`

支持以下入参：

- `query`：关键词，搜 path / summary / description / operationId / tags / 参数名
- `path`：完整路径或路径片段
- `tag`
- `module`
- `method`
- `limit`

每条结果至少包含：

- `module`
- `method`
- `path`
- `summary`
- `operationId`
- `tags`
- `specUrl`

### `get_api_detail`

入参：

- `module`
- `path`
- `method`

返回内容包括：

- `module`
- `method`
- `path`
- `summary`
- `description`
- `tags`
- `consumes`
- `produces`
- `parameters`
- `requestBody`
- `responses`
- `relatedRefs`（从 definitions / schemas / components 中提取的直接引用摘要）
- `rawOperation`
- `specUrl`

### `refresh_specs`

强制重新拉取 `swagger-resources` 和所有模块 spec。

## 环境变量

### 必填

- `SWAGGER_RESOURCES_URL`

### 可选

- `SWAGGER_BASE_URL`
  - 用于补全相对路径；未设置时默认回退到 `SWAGGER_RESOURCES_URL` 的基址
- `SWAGGER_BASIC_AUTH`
  - 格式：`username:password`
- `SWAGGER_HEADERS`
  - JSON 字符串，例如：`{"X-Env":"dev","X-Token":"abc"}`
- `SWAGGER_MODULE_ALLOWLIST`
  - 逗号分隔，例如：`sample-account,sample-auth`
- `CACHE_TTL_MS`
  - 默认 `300000`（5 分钟）
- `LOG_LEVEL`
  - 设为 `debug` 时输出更多日志

## 安装

```bash
npm install
```

## 本地启动 MCP server

### 开发模式

```bash
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources npm run dev
```

### 构建后运行

```bash
npm run build
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources npm start
```

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

其中 smoke test 不再依赖固定示例接口，而是会：

- 从 `list_specs` 结果中选取第一个成功加载且包含接口的模块
- 用该模块调用一次 `find_api`
- 取返回的第一条接口再调用 `get_api_detail`

这样更适合真实 Knife4j 环境，不要求某个特定 path 必须存在。

## 如何本地验证

### 验证 1：确认已加载多个 spec

运行：

```bash
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
SWAGGER_BASIC_AUTH=demo:demo \
npm run test:smoke
```

观察 `list_specs` 输出，应该能看到多个模块，例如：

- `sample-account`
- `sample-auth`
- `sample-notify`

并且有 `loadedModules`、`failedModules`、`totalOperations` 等汇总信息。

### 验证 2：测试 `find_api`

smoke test 会自动选择一个 `status = "loaded"` 且 `operationCount > 0` 的模块，
然后以该模块名调用一次 `find_api`。

预期结果：

- `results` 至少返回 1 条接口
- 返回结果里的 `module` 与自动选中的模块一致

### 验证 3：测试 `get_api_detail`

smoke test 会取 `find_api` 返回的第一条接口，继续调用 `get_api_detail`。

预期可看到：

- `summary`
- `parameters`
- `responses`
- `relatedRefs`
- `rawOperation`

## 接入 Codex

可以直接用 Codex CLI 添加：

```bash
codex mcp add knife4j-swagger \
  --env SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources \
  --env SWAGGER_BASIC_AUTH=demo:demo \
  -- node /ABSOLUTE/PATH/TO/knife4j-mcp/dist/src/index.js
```

或者把下面内容加入 `.codex/config.toml`：

```toml
[mcp_servers.knife4j-swagger]
command = "node"
args = ["/ABSOLUTE/PATH/TO/knife4j-mcp/dist/src/index.js"]

[mcp_servers.knife4j-swagger.env]
SWAGGER_RESOURCES_URL = "http://127.0.0.1:3301/swagger-resources"
SWAGGER_BASIC_AUTH = "demo:demo"
# SWAGGER_BASE_URL = "http://127.0.0.1:3301"
# SWAGGER_HEADERS = "{\"X-Env\":\"dev\"}"
# SWAGGER_MODULE_ALLOWLIST = "sample-account,sample-auth"
# CACHE_TTL_MS = "300000"
```

仓库里也放了一份示例文件：[.codex/config.toml](/Users/lancely/project/knife4j-mcp/.codex/config.toml)

## 代码结构

- [src/index.ts](/Users/lancely/project/knife4j-mcp/src/index.ts)：启动入口
- [src/server.ts](/Users/lancely/project/knife4j-mcp/src/server.ts)：MCP tools 注册
- [src/swagger-registry.ts](/Users/lancely/project/knife4j-mcp/src/swagger-registry.ts)：spec 拉取、缓存、索引、查询
- [src/swagger-parser.ts](/Users/lancely/project/knife4j-mcp/src/swagger-parser.ts)：Swagger 2 / OAS3 统一抽取
- [src/http.ts](/Users/lancely/project/knife4j-mcp/src/http.ts)：认证与请求封装
- [examples/mock-swagger-server.ts](/Users/lancely/project/knife4j-mcp/examples/mock-swagger-server.ts)：本地 mock 服务
- [scripts/smoke-test.ts](/Users/lancely/project/knife4j-mcp/scripts/smoke-test.ts)：最小联调验证

## 当前实现说明

这是一个优先可运行的最小版本，已经覆盖你列出的核心能力。后续如果要继续增强，比较自然的方向有：

- 搜索结果排序进一步细化
- 更深层的 `$ref` 展开与去重
- 针对字段名的专门索引
- 持久化缓存或增量刷新
- 更丰富的 OpenAPI 3 requestBody / schema 展开
