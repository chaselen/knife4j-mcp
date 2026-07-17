import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwaggerRegistry } from "./swagger-registry.js";

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function structured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function createServer(registry: SwaggerRegistry): McpServer {
  const server = new McpServer({
    name: "knife4j-mcp",
    version: "0.3.0",
  });

  server.registerTool(
    "list_specs",
    {
      title: "List Swagger Specs",
      description:
        "List aggregated Knife4j / Swagger modules and their loading status. Use this for module discovery and diagnostics, not for reading API details or fetching spec URLs directly.",
      outputSchema: {
        refreshedAt: z.string(),
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
        limit: z.number().int().positive().max(100).optional(),
      },
      outputSchema: {
        total: z.number(),
        results: z.array(
          z.object({
            module: z.string(),
            method: z.string(),
            path: z.string(),
            summary: z.string().optional(),
            operationId: z.string().optional(),
            tags: z.array(z.string()),
            specUrl: z.string(),
          })
        ),
      },
    },
    async (args) => {
      await registry.ensureLoaded();
      const results = registry.findApi(args).map((item) => ({
        module: item.module,
        method: item.method,
        path: item.path,
        summary: item.summary,
        operationId: item.operationId,
        tags: item.tags,
        specUrl: item.specUrl,
      }));

      const payload = {
        total: results.length,
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
        "Preferred tool for full API documentation. Use module + exact path + HTTP method to read the server-indexed API detail, including recursively expanded request and response schemas. Do not fetch /v2/api-docs, /v3/api-docs, or spec URLs directly.",
      inputSchema: {
        module: z.string(),
        path: z.string(),
        method: z.string(),
      },
      outputSchema: {
        found: z.boolean(),
        detail: z.any().nullable(),
        error: z.string().optional(),
      },
    },
    async ({ module, path, method }) => {
      await registry.ensureLoaded();
      const detail = registry.getApiDetail(module, path, method);
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
