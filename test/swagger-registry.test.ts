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

function containsKey(value: unknown, targetKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsKey(item, targetKey));
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      key === targetKey || containsKey(nestedValue, targetKey)
  );
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

test("API detail compact mode removes duplicated raw fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "/users.json" }]);
    }
    return jsonResponse({
      openapi: "3.0.3",
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: {
        schemas: {
          User: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    });
  };

  try {
    const registry = new SwaggerRegistry(config);
    await registry.refresh();
    const full = registry.getApiDetail("users", "/users", "post");
    const compact = registry.getApiDetail("users", "/users", "post", {
      includeRaw: false,
    });

    assert.equal(containsKey(full, "rawOperation"), true);
    assert.equal(containsKey(full, "raw"), true);
    assert.equal(containsKey(compact, "rawOperation"), false);
    assert.equal(containsKey(compact, "raw"), false);
    assert.deepEqual(compact?.requestBody, full?.requestBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
