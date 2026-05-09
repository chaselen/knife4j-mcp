# AGENTS.md

## 项目目标

本仓库用于实现一个基于 Node.js + TypeScript 的 MCP server，用来读取 Knife4j / Swagger 多模块接口文档，并为 Codex 或其他支持 MCP 的 Agent 提供接口查询能力。

这个服务的核心用途是：

- 读取 `/swagger-resources`
- 拉取每个模块对应的 Swagger/OpenAPI 文档
- 在内存中建立统一搜索索引
- 根据路径、关键词、tag、operation 信息查询接口

实现上优先保持轻量、清晰、可本地运行。

## 当前技术栈

- Node.js
- TypeScript
- `@modelcontextprotocol/sdk`
- `zod`
- 少量 Node 标准库能力

没有明确必要时，不要引入重型框架。

## 关键文件

- `src/index.ts`：stdio MCP server 启动入口
- `src/server.ts`：MCP tools 注册
- `src/swagger-registry.ts`：spec 拉取、缓存、索引、查询
- `src/swagger-parser.ts`：Swagger 2 / OpenAPI 3 统一抽取与映射
- `src/http.ts`：认证请求与 URL 解析
- `examples/mock-swagger-server.ts`：本地多模块 Swagger mock 服务
- `scripts/smoke-test.ts`：stdio MCP 联调 smoke test
- `README.md`：使用说明与验证步骤

## MCP Tools

当前已提供这些 tools：

- `list_specs`
- `find_api`
- `get_api_detail`
- `refresh_specs`

如果修改 tool 行为，请遵循：

- 输出保持结构化，优先返回适合 Agent 消费的 JSON
- 除非有明确目的，不要随意改掉现有核心字段
- 优先做兼容性增强，不轻易做破坏性 schema 变更

## 环境变量

当前支持的运行配置：

- `SWAGGER_RESOURCES_URL`（必填）
- `SWAGGER_BASE_URL`
- `SWAGGER_BASIC_AUTH`
- `SWAGGER_HEADERS`
- `SWAGGER_MODULE_ALLOWLIST`
- `CACHE_TTL_MS`
- `LOG_LEVEL`

不要在源码中硬编码账号、密码、token 或其他敏感信息。

## 协作和编码方式

- 优先实现最小可运行版本，再逐步迭代。
- 优先复用现有的 `registry + parser + server` 分层，不随意新增平行抽象。
- 保持 Swagger 2.0 支持稳定；OpenAPI 3 在可控范围内尽量兼容。
- 做好局部失败隔离：单个模块 spec 拉取失败，不应导致整个服务不可用。
- 能用 Node 内置能力或现有结构解决的问题，不要额外加依赖。

## 验证方式

完成较重要代码改动后，优先执行：

```bash
npm run build
```

做端到端验证时，使用：

```bash
MOCK_SWAGGER_BASIC_AUTH=demo:demo npm run mock:swagger
SWAGGER_RESOURCES_URL=http://127.0.0.1:3301/swagger-resources SWAGGER_BASIC_AUTH=demo:demo npm run test:smoke
```

如果改动影响索引逻辑、查询逻辑或 tool 输出，至少验证：

- `list_specs`
- `find_api`
- `get_api_detail`

## 实现注意事项

- `swagger-resources` 返回的模块地址可能是相对路径，必须正确补全。
- 先把 Swagger/OpenAPI 文档映射成统一内部模型，再做搜索和查询逻辑。
- 搜索结果应尽量简洁；详情结果应尽量完整，方便 Agent 联调。
- 日志保持简洁即可，本地 MCP 使用场景下输出到 stderr 是可以接受的。

## 变更边界

- 不要做与当前目标无关的大范围重构。
- 没有强理由时，不要重命名 MCP tools。
- 不要提交真实凭证、敏感配置或环境私有数据。
- 当启动方式、脚本、配置项或接入方式变化时，要同步更新 `README.md`。
