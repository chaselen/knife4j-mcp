export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "delete"
  | "patch"
  | "head"
  | "options"
  | "trace";

export interface SwaggerResource {
  name?: string;
  url?: string;
  location?: string;
  swaggerVersion?: string;
}

export interface LoadedModuleSpec {
  module: string;
  displayName: string;
  specUrl: string;
  specType: "swagger2" | "openapi3" | "unknown";
  rawSpec: Record<string, unknown>;
  fetchedAt: string;
}

export interface ApiIndexEntry {
  kind: "path" | "webhook";
  module: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  specUrl: string;
  consumes?: string[];
  produces?: string[];
  parameters: unknown[];
  requestBody?: unknown;
  responses?: unknown;
  operation: Record<string, unknown>;
}

export interface ModuleLoadState {
  module: string;
  displayName: string;
  specUrl: string;
  status: "loaded" | "failed";
  error?: string;
  specType?: LoadedModuleSpec["specType"];
  operationCount?: number;
  fetchedAt?: string;
  /** 是否正在使用上一次成功刷新的缓存 */
  stale?: boolean;
}

export interface SwaggerServerConfig {
  swaggerResourcesUrl: string;
  swaggerBaseUrl?: string;
  basicAuth?: string;
  headers: Record<string, string>;
  moduleAllowlist?: Set<string>;
  cacheTtlMs: number;
  requestTimeoutMs: number;
  /** 同时拉取模块文档的最大请求数 */
  fetchConcurrency: number;
  /** 单个模块最多拉取的外部引用文档数 */
  externalRefLimit: number;
}

export interface SearchParams {
  query?: string;
  path?: string;
  tag?: string;
  module?: string;
  method?: string;
  kind?: ApiIndexEntry["kind"];
  deprecated?: boolean;
  limit?: number;
  offset?: number;
}

export interface ApiSearchResult {
  total: number;
  returned: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  results: ApiIndexEntry[];
}

export interface SpecSummary {
  module: string;
  displayName: string;
  specUrl: string;
  status: ModuleLoadState["status"];
  specType?: LoadedModuleSpec["specType"];
  operationCount?: number;
  fetchedAt?: string;
  error?: string;
  stale?: boolean;
}

export interface RefreshResult {
  refreshedAt: string;
  refreshAttemptedAt: string;
  resourcesUrl: string;
  loadedModules: number;
  failedModules: number;
  totalOperations: number;
  modules: SpecSummary[];
  errors: string[];
  /** 是否包含因刷新失败而保留的旧索引 */
  stale: boolean;
}

export interface RefSummary {
  ref: string;
  kind: "schema" | "definition" | "parameter" | "response" | "requestBody" | "unknown";
  name: string;
  summary?: string;
  required?: string[];
  propertyKeys?: string[];
  raw: unknown;
}

export interface ExpandedSchemaNode {
  kind:
    | "object"
    | "array"
    | "primitive"
    | "enum"
    | "union"
    | "intersection"
    | "ref"
    | "unknown";
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enumValues?: unknown[];
  constValue?: unknown;
  defaultValue?: unknown;
  example?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  discriminator?: unknown;
  constraints?: Record<string, unknown>;
  required?: string[];
  ref?: string;
  refName?: string;
  properties?: Record<string, ExpandedSchemaNode>;
  items?: ExpandedSchemaNode;
  variants?: ExpandedSchemaNode[];
  additionalProperties?: boolean | ExpandedSchemaNode;
  raw?: unknown;
}

export interface ExpandedParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  style?: string;
  explode?: boolean;
  allowEmptyValue?: boolean;
  example?: unknown;
  examples?: unknown;
  schema: ExpandedSchemaNode | null;
  raw: unknown;
}
