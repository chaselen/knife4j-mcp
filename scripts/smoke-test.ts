import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface SpecSummary {
  module: string;
  status: "loaded" | "failed";
  operationCount?: number;
}

interface ListSpecsResult {
  loadedModules: number;
  failedModules: number;
  totalOperations: number;
  modules: SpecSummary[];
  errors: string[];
  stale: boolean;
}

interface FindApiResultItem {
  kind: "path" | "webhook";
  module: string;
  method: string;
  path: string;
}

interface FindApiResult {
  total: number;
  returned: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  results: FindApiResultItem[];
}

interface GetApiDetailResult {
  found: boolean;
  detail: unknown | null;
  error?: string;
}

function requireStructuredContent<T>(value: unknown, toolName: string): T {
  if (!value || typeof value !== "object") {
    throw new Error(`Tool ${toolName} returned empty structuredContent`);
  }

  return value as T;
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

async function main(): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    stderr: "inherit",
    env,
  });

  const client = new Client({
    name: "knife4j-mcp-smoke-test",
    version: "0.1.0",
  });

  await client.connect(transport);

  const tools = await client.request(
    {
      method: "tools/list",
      params: {},
    },
    ListToolsResultSchema
  );

  console.log("tools/list");
  console.log(JSON.stringify(tools.tools.map((tool) => tool.name)));
  const expectedTools = [
    "list_specs",
    "find_api",
    "get_api_detail",
    "refresh_specs",
  ];
  if (
    JSON.stringify(tools.tools.map((tool) => tool.name)) !==
    JSON.stringify(expectedTools)
  ) {
    throw new Error("tools/list did not return the expected tool set");
  }

  const listSpecs = await client.request(
    {
      method: "tools/call",
      params: {
        name: "list_specs",
        arguments: {},
      },
    },
    CallToolResultSchema
  );
  console.log("list_specs");

  const listSpecsPayload = requireStructuredContent<ListSpecsResult>(
    listSpecs.structuredContent,
    "list_specs"
  );
  const selectedModule = listSpecsPayload.modules.find(
    (module) => module.status === "loaded" && (module.operationCount ?? 0) > 0
  );

  if (!selectedModule) {
    throw new Error(
      `Smoke test could not find a loaded module with operations. loadedModules=${listSpecsPayload.loadedModules}, failedModules=${listSpecsPayload.failedModules}, totalOperations=${listSpecsPayload.totalOperations}`
    );
  }

  console.log("selected_module");
  console.log(JSON.stringify(selectedModule));

  const findApi = await client.request(
    {
      method: "tools/call",
      params: {
        name: "find_api",
        arguments: {
          module: selectedModule.module,
          limit: 1,
        },
      },
    },
    CallToolResultSchema
  );
  console.log("find_api");

  const findApiPayload = requireStructuredContent<FindApiResult>(
    findApi.structuredContent,
    "find_api"
  );
  const selectedApi = findApiPayload.results[0];

  if (!selectedApi) {
    throw new Error(
      `Smoke test could not find any API in module=${selectedModule.module}`
    );
  }
  if (
    findApiPayload.total < findApiPayload.returned ||
    findApiPayload.returned !== findApiPayload.results.length ||
    findApiPayload.offset !== 0 ||
    findApiPayload.limit !== 1
  ) {
    throw new Error("find_api returned inconsistent pagination metadata");
  }

  console.log("selected_api");
  console.log(JSON.stringify(selectedApi));

  const getApiDetail = await client.request(
    {
      method: "tools/call",
      params: {
        name: "get_api_detail",
        arguments: {
          module: selectedApi.module,
          path: selectedApi.path,
          method: selectedApi.method,
        },
      },
    },
    CallToolResultSchema
  );
  console.log("get_api_detail");

  const getApiDetailPayload = requireStructuredContent<GetApiDetailResult>(
    getApiDetail.structuredContent,
    "get_api_detail"
  );

  if (!getApiDetailPayload.found) {
    throw new Error(
      getApiDetailPayload.error ??
        `Smoke test could not load detail for module=${selectedApi.module}, method=${selectedApi.method}, path=${selectedApi.path}`
    );
  }

  const compactApiDetail = await client.request(
    {
      method: "tools/call",
      params: {
        name: "get_api_detail",
        arguments: {
          module: selectedApi.module,
          path: selectedApi.path,
          method: selectedApi.method,
          includeRaw: false,
        },
      },
    },
    CallToolResultSchema
  );
  const compactApiDetailPayload = requireStructuredContent<GetApiDetailResult>(
    compactApiDetail.structuredContent,
    "get_api_detail(compact)"
  );
  if (
    !compactApiDetailPayload.found ||
    containsKey(compactApiDetailPayload.detail, "raw") ||
    containsKey(compactApiDetailPayload.detail, "rawOperation")
  ) {
    throw new Error("Compact API detail contains raw fields or was not found");
  }

  const exactFindApi = await client.request(
    {
      method: "tools/call",
      params: {
        name: "find_api",
        arguments: {
          module: selectedApi.module,
          path: selectedApi.path,
          method: selectedApi.method,
          limit: 3,
        },
      },
    },
    CallToolResultSchema
  );
  const exactFindApiPayload = requireStructuredContent<FindApiResult>(
    exactFindApi.structuredContent,
    "find_api(exact)"
  );
  if (
    !exactFindApiPayload.results.some(
      (item) =>
        item.module === selectedApi.module &&
        item.path === selectedApi.path &&
        item.method === selectedApi.method
    )
  ) {
    throw new Error("Exact API search did not return the selected API");
  }

  const missingApiDetail = await client.request(
    {
      method: "tools/call",
      params: {
        name: "get_api_detail",
        arguments: {
          module: selectedApi.module,
          path: "/__knife4j_mcp_missing_api__",
          method: "get",
        },
      },
    },
    CallToolResultSchema
  );
  const missingApiDetailPayload = requireStructuredContent<GetApiDetailResult>(
    missingApiDetail.structuredContent,
    "get_api_detail(missing)"
  );
  if (missingApiDetailPayload.found || missingApiDetailPayload.detail !== null) {
    throw new Error("Missing API lookup unexpectedly returned a result");
  }

  if (listSpecsPayload.modules.some((module) => module.module === "mobile-app")) {
    const prefixedFindApi = await client.request(
      {
        method: "tools/call",
        params: {
          name: "find_api",
          arguments: {
            path: "/gateway/mobile-app/records/items/by-key",
            limit: 3,
          },
        },
      },
      CallToolResultSchema
    );
    console.log("find_api_prefixed_path");

    const prefixedFindApiPayload = requireStructuredContent<FindApiResult>(
      prefixedFindApi.structuredContent,
      "find_api(prefixed path)"
    );
    const prefixedApi = prefixedFindApiPayload.results.find(
      (item) =>
        item.module === "mobile-app" &&
        item.path === "/records/items/by-key" &&
        item.method === "get"
    );

    if (!prefixedApi) {
      throw new Error(
        "Smoke test could not resolve prefixed route /gateway/mobile-app/records/items/by-key"
      );
    }
  }

  const refreshSpecs = await client.request(
    {
      method: "tools/call",
      params: { name: "refresh_specs", arguments: {} },
    },
    CallToolResultSchema
  );
  const refreshSpecsPayload = requireStructuredContent<ListSpecsResult>(
    refreshSpecs.structuredContent,
    "refresh_specs"
  );
  if (
    refreshSpecsPayload.loadedModules === 0 ||
    refreshSpecsPayload.totalOperations === 0
  ) {
    throw new Error("Refresh did not retain any loaded API operations");
  }

  console.log("smoke_summary");
  console.log(
    JSON.stringify({
      loadedModules: refreshSpecsPayload.loadedModules,
      failedModules: refreshSpecsPayload.failedModules,
      totalOperations: refreshSpecsPayload.totalOperations,
      compactDetail: "passed",
      exactSearch: "passed",
      missingLookup: "passed",
      refreshSpecs: "passed",
    })
  );

  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
