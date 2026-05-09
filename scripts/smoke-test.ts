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
}

interface FindApiResultItem {
  module: string;
  method: string;
  path: string;
}

interface FindApiResult {
  total: number;
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
  console.log(JSON.stringify(tools, null, 2));

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
  console.log(JSON.stringify(listSpecs.structuredContent, null, 2));

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
  console.log(JSON.stringify(selectedModule, null, 2));

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
  console.log(JSON.stringify(findApi.structuredContent, null, 2));

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

  console.log("selected_api");
  console.log(JSON.stringify(selectedApi, null, 2));

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
  console.log(JSON.stringify(getApiDetail.structuredContent, null, 2));

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

  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
