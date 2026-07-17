#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createServer } from "./server.js";
import { SwaggerRegistry } from "./swagger-registry.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = new SwaggerRegistry(config);
  const server = createServer(registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("knife4j-mcp server started");

  // MCP transport 先完成连接，避免慢速上游阻塞客户端初始化
  void registry
    .ensureLoaded()
    .then((result) => {
      logger.info("Initial swagger load completed", {
        loadedModules: result.loadedModules,
        failedModules: result.failedModules,
        totalOperations: result.totalOperations,
      });
    })
    .catch((error) => {
      logger.error("Initial swagger load failed", { error: String(error) });
    });
}

main().catch((error) => {
  logger.error("knife4j-mcp server failed to start", { error: String(error) });
  process.exit(1);
});
