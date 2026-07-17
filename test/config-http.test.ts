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
