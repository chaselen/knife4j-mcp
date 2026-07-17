import assert from "node:assert/strict";
import test from "node:test";
import { extractApiEntries, resolveParameter } from "../src/swagger-parser.js";
import { LoadedModuleSpec } from "../src/types.js";

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
