import assert from "node:assert/strict";
import test from "node:test";
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

test("refresh keeps the complete stale index when swagger-resources fails", async () => {
  const originalFetch = globalThis.fetch;
  let failResources = false;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      if (failResources) {
        return jsonResponse({ error: "unavailable" }, { status: 503 });
      }
      return jsonResponse([{ name: "users", url: "/users.json" }]);
    }
    return jsonResponse({
      swagger: "2.0",
      paths: { "/users": { get: { responses: {} } } },
    });
  };

  try {
    const registry = new SwaggerRegistry(config);
    await registry.refresh();
    failResources = true;
    const fallback = await registry.refresh();

    assert.equal(fallback.stale, true);
    assert.equal(fallback.modules[0]?.stale, true);
    assert.match(fallback.errors[0] ?? "", /HTTP 503/);
    assert.equal(registry.findApi({ path: "/users" }).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh limits concurrent module requests", async () => {
  const originalFetch = globalThis.fetch;
  let activeRequests = 0;
  let maximumActiveRequests = 0;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse(
        Array.from({ length: 6 }, (_, index) => ({
          name: `module-${index}`,
          url: `/module-${index}.json`,
        }))
      );
    }

    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return jsonResponse({ swagger: "2.0", paths: {} });
  };

  try {
    const registry = new SwaggerRegistry({ ...config, fetchConcurrency: 2 });
    const result = await registry.refresh();

    assert.equal(result.loadedModules, 6);
    assert.equal(maximumActiveRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh isolates duplicate modules and invalid specs", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([
        { name: "duplicate", url: "/first.json" },
        { name: "duplicate", url: "/second.json" },
        { name: "invalid", url: "/invalid.json" },
        { name: "valid", url: "/valid.json" },
      ]);
    }
    if (url.endsWith("/invalid.json")) {
      return jsonResponse({ title: "not an OpenAPI document" });
    }
    return jsonResponse({ swagger: "2.0", paths: {} });
  };

  try {
    const registry = new SwaggerRegistry(config);
    const result = await registry.refresh();

    assert.equal(result.loadedModules, 1);
    assert.equal(result.failedModules, 2);
    assert.equal(result.modules.find((item) => item.module === "duplicate")?.status, "failed");
    assert.equal(result.modules.find((item) => item.module === "invalid")?.status, "failed");
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

test("API detail exposes operation metadata and expanded response data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "/users.json" }]);
    }
    return jsonResponse({
      openapi: "3.1.0",
      security: [{ bearerAuth: [] }],
      servers: [{ url: "/api" }],
      paths: {
        "/users": {
          post: {
            operationId: "createUser",
            deprecated: true,
            externalDocs: { url: "https://docs.example/create-user" },
            responses: {
              "201": {
                description: "Created",
                headers: {
                  Location: { schema: { type: "string", format: "uri" } },
                },
                content: {
                  "application/json": {
                    example: { id: "1" },
                    schema: { type: "object" },
                  },
                },
                links: { user: { operationId: "getUser" } },
              },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    });
  };

  try {
    const registry = new SwaggerRegistry(config);
    await registry.refresh();
    const detail = registry.getApiDetail("users", "/users", "post", {
      includeRaw: false,
    });

    assert.equal(detail?.operationId, "createUser");
    assert.equal(detail?.deprecated, true);
    assert.deepEqual(detail?.security, [{ bearerAuth: [] }]);
    assert.deepEqual(detail?.servers, [{ url: "/api" }]);
    assert.deepEqual(detail?.produces, ["application/json"]);
    assert.equal(
      (detail?.resolvedResponses as Record<string, any>)["201"].headers.Location
        .schema.format,
      "uri"
    );
    assert.deepEqual(
      (detail?.resolvedResponses as Record<string, any>)["201"].content[
        "application/json"
      ].example,
      { id: "1" }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external schema references are bundled and recursively expanded", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/swagger-resources")) {
      return jsonResponse([{ name: "users", url: "/specs/users.json" }]);
    }
    if (url.endsWith("/specs/models.json")) {
      return jsonResponse({
        User: {
          type: "object",
          properties: { address: { $ref: "#/Address" } },
        },
        Address: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      });
    }
    return jsonResponse({
      openapi: "3.0.3",
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "./models.json#/User" },
                },
              },
            },
            responses: {},
          },
        },
      },
    });
  };

  try {
    const registry = new SwaggerRegistry(config);
    await registry.refresh();
    const detail = registry.getApiDetail("users", "/users", "post", {
      includeRaw: false,
    });
    const requestBody = detail?.resolvedRequestBody as Record<string, any>;
    const schema = requestBody.content["application/json"].schema;

    assert.equal(schema.refName, "User");
    assert.equal(schema.properties.address.refName, "Address");
    assert.equal(schema.properties.address.properties.city.type, "string");
    assert.equal(
      requestedUrls.filter((url) => url.endsWith("/specs/models.json")).length,
      1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
