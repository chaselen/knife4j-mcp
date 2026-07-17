import assert from "node:assert/strict";
import test from "node:test";
import { extractApiEntries, resolveParameter } from "../src/swagger-parser.ts";
import { LoadedModuleSpec } from "../src/types.ts";

test("operation parameters override matching path parameters", () => {
  const moduleSpec: LoadedModuleSpec = {
    module: "users",
    displayName: "Users",
    specUrl: "https://docs.example/users.json",
    specType: "openapi3",
    fetchedAt: new Date(0).toISOString(),
    rawSpec: {
      openapi: "3.0.3",
      paths: {
        "/users/{id}": {
          parameters: [{ name: "id", in: "path", required: false }],
          get: {
            parameters: [{ name: "id", in: "path", required: true }],
            responses: {},
          },
        },
      },
    },
  };

  const [entry] = extractApiEntries(moduleSpec);
  assert.equal(entry?.parameters.length, 1);
  assert.deepEqual(entry?.parameters[0], {
    name: "id",
    in: "path",
    required: true,
  });
});

test("local refs decode JSON Pointer escape sequences", () => {
  const spec = {
    definitions: {
      "User/Profile~View": {
        type: "object",
        properties: { id: { type: "string" } },
      },
    },
  };

  const parameter = resolveParameter(
    {
      name: "body",
      in: "body",
      schema: { $ref: "#/definitions/User~1Profile~0View" },
    },
    spec
  );

  assert.equal(parameter.schema?.refName, "User/Profile~View");
  assert.equal(parameter.schema?.kind, "object");
  assert.equal(parameter.schema?.properties?.id?.type, "string");
});

test("schema expansion preserves OpenAPI 3.1 metadata and constraints", () => {
  const parameter = resolveParameter(
    {
      name: "code",
      in: "query",
      deprecated: true,
      style: "form",
      explode: false,
      example: "ABC-1",
      schema: {
        type: ["string", "null"],
        pattern: "^[A-Z]+-[0-9]+$",
        minLength: 3,
        default: "ABC-1",
        readOnly: true,
      },
    },
    {}
  );

  assert.equal(parameter.deprecated, true);
  assert.equal(parameter.explode, false);
  assert.equal(parameter.schema?.type, "string");
  assert.equal(parameter.schema?.nullable, true);
  assert.equal(parameter.schema?.defaultValue, "ABC-1");
  assert.equal(parameter.schema?.readOnly, true);
  assert.deepEqual(parameter.schema?.constraints, {
    minLength: 3,
    pattern: "^[A-Z]+-[0-9]+$",
  });
});

test("OpenAPI webhooks are indexed as API entries", () => {
  const moduleSpec: LoadedModuleSpec = {
    module: "events",
    displayName: "Events",
    specUrl: "https://docs.example/events.json",
    specType: "openapi3",
    fetchedAt: new Date(0).toISOString(),
    rawSpec: {
      openapi: "3.1.0",
      paths: {},
      webhooks: {
        orderChanged: {
          post: { operationId: "orderChanged", responses: {} },
        },
      },
    },
  };

  const [entry] = extractApiEntries(moduleSpec);
  assert.equal(entry?.kind, "webhook");
  assert.equal(entry?.path, "orderChanged");
});
