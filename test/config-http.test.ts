import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { resolveUrl } from "../src/http.js";

test("loadConfig provides a request timeout and accepts an override", () => {
  const defaults = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
  });
  const overridden = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
    SWAGGER_REQUEST_TIMEOUT_MS: "2500",
  });

  assert.equal(defaults.requestTimeoutMs, 15_000);
  assert.equal(overridden.requestTimeoutMs, 2_500);
  assert.equal(defaults.fetchConcurrency, 8);
  assert.equal(defaults.externalRefLimit, 32);
});

test("loadConfig validates module fetch concurrency", () => {
  const configured = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
    SWAGGER_FETCH_CONCURRENCY: "3",
  });

  assert.equal(configured.fetchConcurrency, 3);
  assert.throws(
    () =>
      loadConfig({
        SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
        SWAGGER_FETCH_CONCURRENCY: "0",
      }),
    /between 1 and 100/
  );
});

test("loadConfig validates the external reference limit", () => {
  const disabled = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
    SWAGGER_EXTERNAL_REF_LIMIT: "0",
  });

  assert.equal(disabled.externalRefLimit, 0);
  assert.throws(
    () =>
      loadConfig({
        SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
        SWAGGER_EXTERNAL_REF_LIMIT: "201",
      }),
    /between 0 and 200/
  );
});

test("loadConfig normalizes allowed external reference origins", () => {
  const configured = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
    SWAGGER_EXTERNAL_REF_ORIGINS:
      "https://schemas.example/models, http://localhost:8080/path",
  });

  assert.deepEqual(configured.externalRefOrigins, new Set([
    "https://schemas.example",
    "http://localhost:8080",
  ]));
  assert.throws(
    () =>
      loadConfig({
        SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
        SWAGGER_EXTERNAL_REF_ORIGINS: "file:///tmp/schema.json",
      }),
    /HTTP\(S\)/
  );
});

test("resolveUrl uses the selected spec base for relative module URLs", () => {
  const config = loadConfig({
    SWAGGER_RESOURCES_URL: "https://gateway.example/swagger-resources",
    SWAGGER_BASE_URL: "https://docs.example/root/",
  });

  assert.equal(
    resolveUrl("modules/users.json", config, config.swaggerBaseUrl),
    "https://docs.example/root/modules/users.json"
  );
});
