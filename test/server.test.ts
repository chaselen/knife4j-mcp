import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, PACKAGE_VERSION } from "../src/server.js";
import { SwaggerRegistry } from "../src/swagger-registry.js";
import { SwaggerServerConfig } from "../src/types.js";

const config: SwaggerServerConfig = {
  swaggerResourcesUrl: "https://gateway.example/swagger-resources",
  headers: {},
  cacheTtlMs: 60_000,
  requestTimeoutMs: 1_000,
  fetchConcurrency: 8,
  externalRefLimit: 32,
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function structuredContent(result: { structuredContent?: unknown }): Record<
  string,
  unknown
> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

test("MCP tools expose schema-valid structured responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "/users.json" }]);
    }
    return jsonResponse({
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: {
            operationId: "listUsers",
            responses: { "200": { description: "OK" } },
          },
        },
        "/users/{id}": {
          get: {
            operationId: "getUser",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
  };

  const registry = new SwaggerRegistry(config);
  const server = createServer(registry);
  const client = new Client({ name: "server-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getServerVersion()?.version, PACKAGE_VERSION);

    const tools = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema
    );
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["list_specs", "find_api", "get_api_detail", "refresh_specs"]
    );

    const listSpecs = await client.request(
      {
        method: "tools/call",
        params: { name: "list_specs", arguments: {} },
      },
      CallToolResultSchema
    );
    const listPayload = structuredContent(listSpecs);
    assert.equal(listPayload.loadedModules, 1);
    assert.equal(listPayload.stale, false);

    const findApi = await client.request(
      {
        method: "tools/call",
        params: {
          name: "find_api",
          arguments: { module: "users", limit: 1, offset: 1 },
        },
      },
      CallToolResultSchema
    );
    const findPayload = structuredContent(findApi);
    assert.equal(findPayload.total, 2);
    assert.equal(findPayload.returned, 1);
    assert.equal(findPayload.offset, 1);
    assert.equal(findPayload.hasMore, false);

    const detail = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_api_detail",
          arguments: {
            module: "users",
            path: "/users/{id}",
            method: "get",
            includeRaw: false,
          },
        },
      },
      CallToolResultSchema
    );
    assert.equal(structuredContent(detail).found, true);

    const refresh = await client.request(
      {
        method: "tools/call",
        params: { name: "refresh_specs", arguments: {} },
      },
      CallToolResultSchema
    );
    assert.equal(structuredContent(refresh).loadedModules, 1);
  } finally {
    await clientTransport.close();
    await server.close();
    globalThis.fetch = originalFetch;
  }
});
