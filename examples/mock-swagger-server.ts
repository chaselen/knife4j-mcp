import { Buffer } from "node:buffer";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.MOCK_SWAGGER_PORT ?? "3301");
const AUTH = process.env.MOCK_SWAGGER_BASIC_AUTH?.trim();

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH) {
    return true;
  }

  const actual = req.headers.authorization;
  const expected = `Basic ${Buffer.from(AUTH, "utf8").toString("base64")}`;
  return actual === expected;
}

const swaggerResources = [
  {
    name: "sample-account",
    url: "/sample-account/v2/api-docs",
    location: "/sample-account/v2/api-docs",
    swaggerVersion: "2.0",
  },
  {
    name: "sample-auth",
    url: "/sample-auth/v2/api-docs",
    location: "/sample-auth/v2/api-docs",
    swaggerVersion: "2.0",
  },
  {
    name: "sample-notify",
    url: "/demo/sample-notify/v3/api-docs",
    location: "/demo/sample-notify/v3/api-docs",
    swaggerVersion: "2.0",
  },
  {
    name: "mobile-app",
    url: "/gateway/mobile-app/v2/api-docs",
    location: "/gateway/mobile-app/v2/api-docs",
    swaggerVersion: "2.0",
  },
];

const specs: Record<string, unknown> = {
  "/sample-account/v2/api-docs": {
    swagger: "2.0",
    info: { title: "Sample Account API", version: "1.0.0" },
    tags: [{ name: "Account" }],
    paths: {
      "/sample-account/accounts/page": {
        get: {
          tags: ["Account"],
          summary: "Query account page",
          description: "Paged query for accounts",
          operationId: "pageAccounts",
          parameters: [
            {
              name: "current",
              in: "query",
              type: "integer",
              description: "Current page",
            },
            {
              name: "size",
              in: "query",
              type: "integer",
              description: "Page size",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              schema: {
                $ref: "#/definitions/AccountPageResult",
              },
            },
          },
        },
      },
      "/sample-account/accounts/{accountId}": {
        get: {
          tags: ["Account"],
          summary: "Get account detail",
          operationId: "getAccountById",
          parameters: [
            {
              name: "accountId",
              in: "path",
              required: true,
              type: "string",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              schema: {
                $ref: "#/definitions/AccountView",
              },
            },
          },
        },
      },
    },
    definitions: {
      AccountView: {
        type: "object",
        description: "Account view object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      AccountPageResult: {
        type: "object",
        properties: {
          records: {
            type: "array",
            items: {
              $ref: "#/definitions/AccountView",
            },
          },
          total: {
            type: "integer",
            format: "int64",
          },
        },
      },
    },
  },
  "/sample-auth/v2/api-docs": {
    swagger: "2.0",
    info: { title: "Sample Auth API", version: "1.0.0" },
    tags: [{ name: "Auth" }],
    paths: {
      "/sample-auth/oauth/token": {
        post: {
          tags: ["Auth"],
          summary: "Get access token",
          description: "OAuth password login",
          operationId: "issueToken",
          consumes: ["application/x-www-form-urlencoded"],
          parameters: [
            {
              name: "username",
              in: "formData",
              required: true,
              type: "string",
            },
            {
              name: "password",
              in: "formData",
              required: true,
              type: "string",
            },
          ],
          responses: {
            "200": {
              description: "OK",
            },
          },
        },
      },
    },
  },
  "/demo/sample-notify/v3/api-docs": {
    openapi: "3.0.1",
    info: { title: "Sample Notify API", version: "1.0.0" },
    paths: {
      "/demo/sample-notify/messages/send": {
        post: {
          tags: ["Notification"],
          summary: "Send notification message",
          description: "Create a notification message",
          operationId: "sendNotificationMessage",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SendNotificationRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SendNotificationResponse",
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SendNotificationRequest: {
          type: "object",
          required: ["content", "receiver"],
          properties: {
            content: { type: "string" },
            receiver: { type: "string" },
          },
        },
        SendNotificationResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            messageId: { type: "string" },
          },
        },
      },
    },
  },
  "/gateway/mobile-app/v2/api-docs": {
    swagger: "2.0",
    info: { title: "Mobile App API", version: "1.0.0" },
    basePath: "/gateway",
    tags: [{ name: "RecordLookup" }],
    paths: {
      "/records/items/by-key": {
        get: {
          tags: ["RecordLookup"],
          summary: "Get records by key",
          description: "Query records with itemKey",
          operationId: "getRecordsByKey",
          parameters: [
            {
              name: "itemKey",
              in: "query",
              required: true,
              type: "string",
              description: "Record key",
            },
          ],
          responses: {
            "200": {
              description: "OK",
            },
          },
        },
      },
    },
  },
};

const server = createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (!isAuthorized(req)) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", 'Basic realm="mock-swagger"');
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.url === "/swagger-resources") {
    sendJson(res, 200, swaggerResources);
    return;
  }

  const spec = specs[req.url];
  if (spec) {
    sendJson(res, 200, spec);
    return;
  }

  sendJson(res, 404, { error: "Not found", path: req.url });
});

server.listen(PORT, () => {
  process.stderr.write(
    `[mock-swagger] listening on http://127.0.0.1:${PORT} with auth=${AUTH ? "on" : "off"}\n`
  );
});
