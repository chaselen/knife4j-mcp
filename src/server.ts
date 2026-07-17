import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwaggerRegistry } from "./swagger-registry.ts";

/** npm 包名称 */
const PACKAGE_NAME = "@chaselen/knife4j-mcp";

/** package.json 中使用的包信息 */
interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

/**
 * 从当前源码或编译产物目录向上查找 package.json，并读取服务版本。
 */
function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packagePath = resolve(directory, "package.json");
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(
        readFileSync(packagePath, "utf8")
      ) as PackageMetadata;
      if (
        metadata.name === PACKAGE_NAME &&
        typeof metadata.version === "string" &&
        metadata.version.length > 0
      ) {
        return metadata.version;
      }
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      break;
    }
    directory = parentDirectory;
  }

  throw new Error(`Could not find package.json for ${PACKAGE_NAME}`);
}

/** 当前 MCP 服务版本 */
export const PACKAGE_VERSION = readPackageVersion();

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function structured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function createServer(registry: SwaggerRegistry): McpServer {
  const server = new McpServer({
    name: "knife4j-mcp",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "list_specs",
    {
      title: "List Swagger Specs",
      description:
        "List aggregated Knife4j / Swagger modules and their loading status. Use this for module discovery and diagnostics, not for reading API details or fetching spec URLs directly.",
      outputSchema: {
        refreshedAt: z.string(),
        refreshAttemptedAt: z.string(),
        resourcesUrl: z.string(),
        loadedModules: z.number(),
        failedModules: z.number(),
        totalOperations: z.number(),
        modules: z.array(
          z.object({
            module: z.string(),
            displayName: z.string(),
            specUrl: z.string(),
            status: z.enum(["loaded", "failed"]),
            specType: z.enum(["swagger2", "openapi3", "unknown"]).optional(),
            operationCount: z.number().optional(),
            fetchedAt: z.string().optional(),
            error: z.string().optional(),
            stale: z.boolean().optional(),
          })
        ),
        errors: z.array(z.string()),
        stale: z.boolean(),
      },
    },
    async () => {
      const result = await registry.ensureLoaded();
      return {
        content: [{ type: "text", text: jsonText(result) }],
        structuredContent: structured(result),
      };
    }
  );

  server.registerTool(
    "find_api",
    {
      title: "Find API",
      description:
        "Find candidate APIs by path, keyword, tag, module, or method. After locating a candidate, call get_api_detail with its module, path, and method to read the full indexed API documentation instead of fetching Swagger/OpenAPI spec URLs directly.",
      inputSchema: {
        query: z.string().optional(),
        path: z.string().optional(),
        tag: z.string().optional(),
        module: z.string().optional(),
        method: z.string().optional(),
        kind: z.enum(["path", "webhook"]).optional(),
        deprecated: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      outputSchema: {
        total: z.number(),
        returned: z.number(),
        offset: z.number(),
        limit: z.number(),
        hasMore: z.boolean(),
        results: z.array(
          z.object({
            kind: z.enum(["path", "webhook"]),
            module: z.string(),
            method: z.string(),
            path: z.string(),
            summary: z.string().optional(),
            operationId: z.string().optional(),
            tags: z.array(z.string()),
            deprecated: z.boolean(),
            specUrl: z.string(),
          })
        ),
      },
    },
    async (args) => {
      await registry.ensureLoaded();
      const searchResult = registry.searchApi(args);
      const results = searchResult.results.map((item) => ({
        kind: item.kind,
        module: item.module,
        method: item.method,
        path: item.path,
        summary: item.summary,
        operationId: item.operationId,
        tags: item.tags,
        deprecated: item.operation.deprecated === true,
        specUrl: item.specUrl,
      }));

      const payload = {
        total: searchResult.total,
        returned: searchResult.returned,
        offset: searchResult.offset,
        limit: searchResult.limit,
        hasMore: searchResult.hasMore,
        results,
      };

      return {
        content: [{ type: "text", text: jsonText(payload) }],
        structuredContent: structured(payload),
      };
    }
  );

  server.registerTool(
    "get_api_detail",
    {
      title: "Get API Detail",
      description:
        "Preferred tool for API documentation. Use module + exact path + HTTP method to read recursively expanded request and response schemas. Set includeRaw=false for a compact, agent-friendly response; omit it for the backward-compatible full response. Do not fetch spec URLs directly.",
      inputSchema: {
        module: z.string(),
        path: z.string(),
        method: z.string(),
        includeRaw: z.boolean().optional(),
      },
      outputSchema: {
        found: z.boolean(),
        detail: z.any().nullable(),
        error: z.string().optional(),
      },
    },
    async ({ module, path, method, includeRaw }) => {
      await registry.ensureLoaded();
      const detail = registry.getApiDetail(module, path, method, { includeRaw });
      const payload = detail
        ? { found: true, detail }
        : {
            found: false,
            detail: null,
            error: `API not found for module=${module}, method=${method}, path=${path}`,
          };

      return {
        content: [{ type: "text", text: jsonText(payload) }],
        structuredContent: structured(payload),
      };
    }
  );

  server.registerTool(
    "refresh_specs",
    {
      title: "Refresh Swagger Specs",
      description:
        "Force a reload of swagger-resources and all module specs while keeping partial failures isolated. Use this when upstream docs changed or when a previous lookup returned stale results.",
      outputSchema: {
        refreshedAt: z.string(),
        refreshAttemptedAt: z.string(),
        resourcesUrl: z.string(),
        loadedModules: z.number(),
        failedModules: z.number(),
        totalOperations: z.number(),
        modules: z.array(
          z.object({
            module: z.string(),
            displayName: z.string(),
            specUrl: z.string(),
            status: z.enum(["loaded", "failed"]),
            specType: z.enum(["swagger2", "openapi3", "unknown"]).optional(),
            operationCount: z.number().optional(),
            fetchedAt: z.string().optional(),
            error: z.string().optional(),
            stale: z.boolean().optional(),
          })
        ),
        errors: z.array(z.string()),
        stale: z.boolean(),
      },
    },
    async () => {
      const result = await registry.refresh();
      return {
        content: [{ type: "text", text: jsonText(result) }],
        structuredContent: structured(result),
      };
    }
  );

  return server;
}
