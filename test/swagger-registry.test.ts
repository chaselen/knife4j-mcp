import assert from "node:assert/strict";
import test from "node:test";
import { SwaggerRegistry } from "../src/swagger-registry.js";
import { SwaggerServerConfig } from "../src/types.js";

const config: SwaggerServerConfig = {
  swaggerResourcesUrl: "https://gateway.example/swagger-resources",
  headers: {},
  cacheTtlMs: 60_000,
  requestTimeoutMs: 1_000,
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json" },
  });
}

test("refresh retains the previous module index after a transient failure", async () => {
  const originalFetch = globalThis.fetch;
  let failSpec = false;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "/users.json" }]);
    }
    if (failSpec) {
      return jsonResponse({ error: "temporary" }, { status: 503 });
    }
    return jsonResponse({
      swagger: "2.0",
      paths: {
        "/users": {
          get: { summary: "List users", responses: { "200": {} } },
        },
      },
    });
  };

  try {
    const registry = new SwaggerRegistry(config);
    const initial = await registry.refresh();
    failSpec = true;
    const refreshed = await registry.refresh();

    assert.equal(initial.totalOperations, 1);
    assert.equal(refreshed.loadedModules, 1);
    assert.equal(refreshed.failedModules, 0);
    assert.equal(refreshed.modules[0]?.stale, true);
    assert.equal(registry.findApi({ path: "/users" }).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registry resolves module URLs against swaggerBaseUrl", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "specs/users.json" }]);
    }
    return jsonResponse({ swagger: "2.0", paths: {} });
  };

  try {
    const registry = new SwaggerRegistry({
      ...config,
      swaggerBaseUrl: "https://docs.example/api/",
    });
    await registry.refresh();

    assert.deepEqual(requestedUrls, [
      "https://gateway.example/swagger-resources",
      "https://docs.example/api/specs/users.json",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
