import { loadConfig } from "./config.js";
import { fetchJson, resolveUrl } from "./http.js";
import { logger } from "./logger.js";
import {
  collectExpandedRelatedRefs,
  detectSpecType,
  extractApiEntries,
  resolveParameter,
  resolveRequestBody,
  resolveResponses,
} from "./swagger-parser.js";
import {
  ApiIndexEntry,
  LoadedModuleSpec,
  ModuleLoadState,
  RefreshResult,
  SearchParams,
  SpecSummary,
  SwaggerResource,
  SwaggerServerConfig,
} from "./types.js";

/**
 * 从 swagger-resources 条目里提取模块名。
 */
function normalizeModuleName(resource: SwaggerResource): string {
  return (resource.name || resource.location || resource.url || "unknown").trim();
}

function uniqueStringList(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeForSearch(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeModuleForSearch(value: string | undefined): string {
  return normalizeForSearch(value).replace(/^\/+|\/+$/g, "");
}

/**
 * 统一路由字符串格式，便于后续做路径匹配。
 *
 * 这里会去掉 query/hash、收敛重复斜杠，并补上前导 `/`。
 */
function normalizeRoutePath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  // 搜索输入可能是完整 URL，也可能是带 query/hash 的路由；
  // 先在这里规整掉，后面的逻辑就只需要关注路径本身。
  const withoutSuffix = trimmed.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!withoutSuffix) {
    return "";
  }

  const collapsed = withoutSuffix.replace(/\/+/g, "/");
  const withLeadingSlash = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  return withLeadingSlash.length > 1
    ? withLeadingSlash.replace(/\/+$/g, "")
    : withLeadingSlash;
}

function looksLikeRoute(value: string): boolean {
  return value.startsWith("/") && value.includes("/");
}

/**
 * 从自由输入里提取“看起来像路由”的片段。
 *
 * 比如 query 中混着自然语言和 `/gateway/mobile-app/...` 时，
 * 这里会把路由部分摘出来，供路径匹配复用。
 */
function extractRouteCandidates(value: string | undefined): string[] {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>();
  if (looksLikeRoute(trimmed)) {
    const normalized = normalizeRoutePath(trimmed);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  const routeMatches = trimmed.match(/\/[A-Za-z0-9._{}-]+(?:\/[A-Za-z0-9._{}-]+)+/g) ?? [];
  for (const match of routeMatches) {
    const normalized = normalizeRoutePath(match);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

/**
 * 把完整路由展开成多组可匹配的 needle。
 *
 * 例如 `/gateway/mobile-app/records/items/by-key` 会展开出：
 * - `/gateway/mobile-app/records/items/by-key`
 * - `/mobile-app/records/items/by-key`
 * - `/records/items/by-key`
 * - ...
 *
 * 这样可以兼容“网关暴露的完整路由”和“spec 里记录的短路径”不一致的场景。
 */
function expandRouteNeedles(value: string | undefined): string[] {
  const needles = new Set<string>();

  for (const candidate of extractRouteCandidates(value)) {
    needles.add(normalizeForSearch(candidate));

    // 允许完整网关路径命中只保存尾部 path 的 spec 条目。
    const segments = candidate.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      needles.add(normalizeForSearch(`/${segments.slice(index).join("/")}`));
    }
  }

  return [...needles];
}

/**
 * 尝试从 URL 或路径字符串中提取 pathname，并复用统一的路径规范化逻辑。
 */
function normalizeUrlPathCandidate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("/")) {
    return normalizeRoutePath(trimmed);
  }

  try {
    return normalizeRoutePath(new URL(trimmed).pathname);
  } catch {
    try {
      return normalizeRoutePath(new URL(trimmed, "http://placeholder.local").pathname);
    } catch {
      return normalizeRoutePath(trimmed);
    }
  }
}

/**
 * 从 spec 文档地址中剥离 `/v2/api-docs`、`/openapi.json` 这类后缀，
 * 得到更接近业务路由前缀的部分。
 */
function stripApiDocsSuffix(pathname: string): string {
  return pathname
    .replace(/\/v\d+\/api-docs(?:-ext)?$/i, "")
    .replace(/\/api-docs(?:-ext)?$/i, "")
    .replace(/\/openapi(?:\.json)?$/i, "")
    .replace(/\/swagger(?:\.json)?$/i, "");
}

/**
 * 把前缀路径拼到目标路径前面，并避免重复拼接。
 */
function prependRoutePrefix(prefix: string, path: string): string {
  const normalizedPrefix = normalizeRoutePath(prefix);
  const normalizedPath = normalizeRoutePath(path);

  if (!normalizedPrefix) {
    return normalizedPath;
  }

  if (!normalizedPath) {
    return normalizedPrefix;
  }

  if (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  ) {
    return normalizedPath;
  }

  return `${normalizedPrefix.replace(/\/+$/g, "")}/${normalizedPath.replace(/^\/+/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSwaggerResource(value: unknown): value is SwaggerResource {
  if (!isRecord(value)) {
    return false;
  }

  return [value.name, value.url, value.location, value.swaggerVersion].every(
    (item) => item === undefined || typeof item === "string"
  );
}

/**
 * 为单个 API 生成若干等价路径别名。
 *
 * 这些别名主要来自：
 * - spec 原始 path
 * - 模块名前缀
 * - Swagger 2 的 `basePath`
 * - OpenAPI 3 的 `servers`
 * - spec URL 推导出的前缀
 *
 * 这样 `find_api` 无论收到短路径还是完整网关路径，都更容易召回同一个接口。
 */
function buildPathAliases(entry: ApiIndexEntry, moduleSpec: LoadedModuleSpec): string[] {
  const rawPath = normalizeRoutePath(entry.path);
  const modulePrefix = normalizeRoutePath(moduleSpec.module);
  const prefixes = new Set<string>();

  // Knife4j / Swagger 场景里，经常存在“外部访问路径更长、spec 内部 path 更短”的情况，
  // 这里把几种常见前缀都并进来，减少第一次搜索漏掉接口的概率。
  if (typeof moduleSpec.rawSpec.basePath === "string") {
    const normalizedBasePath = normalizeRoutePath(moduleSpec.rawSpec.basePath);
    if (normalizedBasePath) {
      prefixes.add(normalizedBasePath);
    }
  }

  if (Array.isArray(moduleSpec.rawSpec.servers)) {
    for (const server of moduleSpec.rawSpec.servers) {
      if (!isRecord(server) || typeof server.url !== "string") {
        continue;
      }

      const serverPath = normalizeUrlPathCandidate(server.url);
      if (serverPath) {
        prefixes.add(serverPath);
      }
    }
  }

  const specUrlPrefix = stripApiDocsSuffix(normalizeUrlPathCandidate(moduleSpec.specUrl));
  if (specUrlPrefix) {
    prefixes.add(specUrlPrefix);
  }

  const aliases = new Set<string>();
  if (rawPath) {
    aliases.add(normalizeForSearch(rawPath));
  }

  const modulePath = prependRoutePrefix(modulePrefix, rawPath);
  if (modulePath) {
    aliases.add(normalizeForSearch(modulePath));
  }

  for (const prefix of prefixes) {
    const prefixedPath = prependRoutePrefix(prefix, rawPath);
    if (prefixedPath) {
      aliases.add(normalizeForSearch(prefixedPath));
    }

    if (modulePath && modulePrefix && !prefix.endsWith(modulePrefix)) {
      const moduleScopedPath = prependRoutePrefix(prefix, modulePath);
      if (moduleScopedPath) {
        aliases.add(normalizeForSearch(moduleScopedPath));
      }
    }
  }

  return [...aliases];
}

function includesNeedle(value: string | undefined, needle: string): boolean {
  return normalizeForSearch(value).includes(needle);
}

/**
 * 组装一个用于模糊搜索的文本块。
 *
 * 这里会把模块名、方法、路径、tag、operationId 以及参数名串起来，
 * 方便 `query` 走一次统一的包含匹配。
 */
function buildSearchText(entry: ApiIndexEntry, pathAliases: string[]): string {
  const parameterNames = entry.parameters
    .flatMap((parameter) => {
      if (
        typeof parameter === "object" &&
        parameter !== null &&
        "name" in parameter &&
        typeof parameter.name === "string"
      ) {
        const description =
          "description" in parameter && typeof parameter.description === "string"
            ? parameter.description
            : "";
        return [parameter.name, description];
      }

      return [];
    })
    .join(" ");

  return [
    entry.module,
    entry.method,
    entry.path,
    pathAliases.join(" "),
    entry.summary,
    entry.description,
    entry.operationId,
    entry.tags.join(" "),
    parameterNames,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

interface SearchMetadata {
  pathAliases: string[];
  searchText: string;
}

function stripRawFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRawFields);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "raw")
      .map(([key, nestedValue]) => [key, stripRawFields(nestedValue)])
  );
}

/**
 * SwaggerRegistry 负责：
 * - 拉取 swagger-resources 与各模块 spec
 * - 按模块维护加载状态
 * - 建立内存索引，支持 `find_api` / `get_api_detail`
 */
export class SwaggerRegistry {
  private readonly config: SwaggerServerConfig;
  private lastRefreshAt = 0;
  private apiEntries: ApiIndexEntry[] = [];
  private moduleSpecs = new Map<string, LoadedModuleSpec>();
  private moduleStates = new Map<string, ModuleLoadState>();
  private lastErrors: string[] = [];
  private refreshPromise?: Promise<RefreshResult>;
  private searchMetadata = new WeakMap<ApiIndexEntry, SearchMetadata>();

  constructor(config: SwaggerServerConfig = loadConfig()) {
    this.config = config;
  }

  /**
   * 确保内存中的 spec 已完成加载。
   *
   * - 首次访问时会触发刷新
   * - TTL 未过期时直接复用已有结果
   * - 并发请求会复用同一个 refreshPromise，避免重复拉取
   */
  async ensureLoaded(force = false): Promise<RefreshResult> {
    const now = Date.now();
    const expired =
      this.lastRefreshAt === 0 ||
      this.config.cacheTtlMs === 0 ||
      now - this.lastRefreshAt >= this.config.cacheTtlMs;

    if (!force && !expired && this.moduleStates.size > 0) {
      return this.buildRefreshResult();
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.reload()
        .catch((error) => {
          this.lastErrors.push(String(error));
          throw error;
        })
        .finally(() => {
          this.refreshPromise = undefined;
        });
    }

    return this.refreshPromise;
  }

  /**
   * 强制刷新所有模块 spec。
   */
  async refresh(): Promise<RefreshResult> {
    return this.ensureLoaded(true);
  }

  /**
   * 返回当前模块加载状态摘要。
   */
  listSpecs(): SpecSummary[] {
    return [...this.moduleStates.values()].map((state) => ({
      module: state.module,
      displayName: state.displayName,
      specUrl: state.specUrl,
      status: state.status,
      specType: state.specType,
      operationCount: state.operationCount,
      fetchedAt: state.fetchedAt,
      error: state.error,
      stale: state.stale,
    }));
  }

  /**
   * 根据 path / query / tag / module / method 搜索接口。
   *
   * 搜索分两步：
   * 1. 先做过滤，尽量排除明显无关的接口
   * 2. 再做简单打分，把更像目标结果的接口排前面
   */
  findApi(params: SearchParams): ApiIndexEntry[] {
    const limit = params.limit && params.limit > 0 ? params.limit : 20;
    const query = normalizeForSearch(params.query);
    const path = normalizeForSearch(params.path);
    const pathNeedles = expandRouteNeedles(params.path);
    const queryPathNeedles = expandRouteNeedles(params.query);
    const tag = normalizeForSearch(params.tag);
    const module = normalizeModuleForSearch(params.module);
    const method = normalizeForSearch(params.method);

    const scored: Array<{ entry: ApiIndexEntry; score: number }> = [];

    for (const entry of this.apiEntries) {
      const metadata = this.getSearchMetadata(entry);

      if (module && normalizeModuleForSearch(entry.module) !== module) {
        continue;
      }

      if (method && normalizeForSearch(entry.method) !== method) {
        continue;
      }

      if (
        path &&
        !this.matchesPathNeedles(
          metadata.pathAliases,
          pathNeedles.length > 0 ? pathNeedles : [path]
        )
      ) {
        continue;
      }

      if (tag && !entry.tags.some((entryTag) => includesNeedle(entryTag, tag))) {
        continue;
      }

      // query 先走全文匹配，路径形式的输入再回退到 alias-aware 匹配
      if (
        query &&
        !metadata.searchText.includes(query) &&
        (queryPathNeedles.length === 0 ||
          !this.matchesPathNeedles(metadata.pathAliases, queryPathNeedles))
      ) {
        continue;
      }

      scored.push({
        entry,
        score: this.scoreEntry(
          entry,
          metadata,
          { query, path, pathNeedles, queryPathNeedles, tag }
        ),
      });
    }

    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  /**
   * 按模块名 + 精确 path + method 获取单个接口详情。
   */
  getApiDetail(
    moduleName: string,
    path: string,
    method: string,
    options: { includeRaw?: boolean } = {}
  ): Record<string, unknown> | null {
    const normalizedModule = normalizeModuleForSearch(moduleName);
    const normalizedPath = path.trim();
    const normalizedMethod = normalizeForSearch(method);

    const entry = this.apiEntries.find(
      (candidate) =>
        normalizeModuleForSearch(candidate.module) === normalizedModule &&
        candidate.path === normalizedPath &&
        candidate.method === normalizedMethod
    );

    if (!entry) {
      return null;
    }

    const moduleSpec = this.moduleSpecs.get(entry.module);
    const relatedRefs = moduleSpec
      ? collectExpandedRelatedRefs(entry, moduleSpec.rawSpec)
      : [];
    const resolvedParameters = moduleSpec
      ? entry.parameters.map((parameter) =>
          resolveParameter(parameter, moduleSpec.rawSpec)
        )
      : [];
    const resolvedRequestBody = moduleSpec
      ? resolveRequestBody(entry.requestBody, moduleSpec.rawSpec)
      : null;
    const resolvedResponses = moduleSpec
      ? resolveResponses(entry.responses, moduleSpec.rawSpec)
      : {};

    const includeRaw = options.includeRaw ?? true;
    const detail = {
      module: entry.module,
      method: entry.method,
      path: entry.path,
      summary: entry.summary,
      description: entry.description,
      tags: entry.tags,
      consumes: entry.consumes ?? [],
      produces: entry.produces ?? [],
      parameters: entry.parameters,
      resolvedParameters: includeRaw
        ? resolvedParameters
        : stripRawFields(resolvedParameters),
      requestBody: entry.requestBody ?? null,
      resolvedRequestBody: includeRaw
        ? resolvedRequestBody
        : stripRawFields(resolvedRequestBody),
      responses: entry.responses ?? {},
      resolvedResponses: includeRaw
        ? resolvedResponses
        : stripRawFields(resolvedResponses),
      relatedRefs: includeRaw ? relatedRefs : stripRawFields(relatedRefs),
      ...(includeRaw ? { rawOperation: entry.operation } : {}),
      specUrl: entry.specUrl,
    };

    return detail;
  }

  getStatus(): RefreshResult {
    return this.buildRefreshResult();
  }

  /**
   * 真正执行一次全量刷新：
   * - 先读取 swagger-resources
   * - 再并发拉取每个模块的 spec
   * - 单模块失败只记录错误，不影响其他模块可用
   */
  private async reload(): Promise<RefreshResult> {
    logger.info("Refreshing swagger resources", {
      resourcesUrl: this.config.swaggerResourcesUrl,
    });

    const resourcesUrl = resolveUrl(
      this.config.swaggerResourcesUrl,
      this.config,
      this.config.swaggerBaseUrl
    );

    const resources = await fetchJson<unknown>(resourcesUrl, this.config);
    if (!Array.isArray(resources)) {
      throw new Error("swagger-resources response must be an array");
    }
    const validResources = resources.filter(isSwaggerResource);
    const invalidResourceCount = resources.length - validResources.length;
    if (invalidResourceCount > 0) {
      throw new Error(
        `swagger-resources contains ${invalidResourceCount} invalid entr${invalidResourceCount === 1 ? "y" : "ies"}`
      );
    }
    const filteredResources = this.filterResources(validResources);

    const moduleStates = new Map<string, ModuleLoadState>();
    const moduleSpecs = new Map<string, LoadedModuleSpec>();
    const apiEntries: ApiIndexEntry[] = [];
    const errors: string[] = [];

    await Promise.all(
      filteredResources.map(async (resource) => {
        const module = normalizeModuleName(resource);
        const resourceUrl = resource.location ?? resource.url;
        if (!resourceUrl) {
          const error = `Resource ${module} is missing url/location`;
          errors.push(error);
          moduleStates.set(module, {
            module,
            displayName: resource.name || module,
            specUrl: "",
            status: "failed",
            error,
          });
          return;
        }

        const specUrl = resolveUrl(
          resourceUrl,
          this.config,
          this.config.swaggerBaseUrl ?? resourcesUrl
        );

        try {
          const rawSpec = await fetchJson<unknown>(specUrl, this.config);
          if (!isRecord(rawSpec)) {
            throw new Error(`Spec ${specUrl} must be a JSON object`);
          }
          const detectedType = detectSpecType(rawSpec);
          const moduleSpec: LoadedModuleSpec = {
            module,
            displayName: resource.name || module,
            specUrl,
            specType: detectedType,
            rawSpec,
            fetchedAt: new Date().toISOString(),
          };
          const entries = extractApiEntries(moduleSpec);
          moduleSpecs.set(module, moduleSpec);
          apiEntries.push(...entries);
          moduleStates.set(module, {
            module,
            displayName: resource.name || module,
            specUrl,
            status: "loaded",
            specType: detectedType,
            operationCount: entries.length,
            fetchedAt: moduleSpec.fetchedAt,
          });
        } catch (error) {
          // 单个模块失败不应该拖垮整个 registry。
          const message = String(error);
          logger.warn("Failed to load module spec", { module, specUrl, error: message });
          errors.push(`${module}: ${message}`);
          const previousSpec = this.moduleSpecs.get(module);
          if (previousSpec) {
            const previousEntries = this.apiEntries.filter(
              (entry) => entry.module === module
            );
            moduleSpecs.set(module, previousSpec);
            apiEntries.push(...previousEntries);
            moduleStates.set(module, {
              module,
              displayName: previousSpec.displayName,
              specUrl: previousSpec.specUrl,
              status: "loaded",
              specType: previousSpec.specType,
              operationCount: previousEntries.length,
              fetchedAt: previousSpec.fetchedAt,
              stale: true,
              error: message,
            });
            return;
          }

          moduleStates.set(module, {
            module,
            displayName: resource.name || module,
            specUrl,
            status: "failed",
            error: message,
          });
        }
      })
    );

    this.apiEntries = apiEntries;
    this.moduleSpecs = moduleSpecs;
    this.rebuildSearchMetadata();
    this.moduleStates = moduleStates;
    this.lastErrors = uniqueStringList(errors);
    this.lastRefreshAt = Date.now();

    return this.buildRefreshResult();
  }

  private filterResources(resources: SwaggerResource[]): SwaggerResource[] {
    if (!this.config.moduleAllowlist || this.config.moduleAllowlist.size === 0) {
      return resources;
    }

    return resources.filter((resource) => {
      const candidates = [
        resource.name?.trim(),
        resource.url?.trim(),
        resource.location?.trim(),
      ].filter((value): value is string => Boolean(value));

      return candidates.some((candidate) =>
        this.config.moduleAllowlist?.has(candidate)
      );
    });
  }

  private matchesPathNeedles(pathAliases: string[], needles: string[]): boolean {
    return needles.some((needle) => pathAliases.some((alias) => alias.includes(needle)));
  }

  private scorePathNeedles(
    pathAliases: string[],
    needles: string[],
    exactScore: number,
    partialScore: number
  ): number {
    if (needles.length === 0) {
      return 0;
    }

    let score = 0;

    for (const needle of needles) {
      if (pathAliases.some((alias) => alias === needle)) {
        score = Math.max(score, exactScore);
      } else if (pathAliases.some((alias) => alias.includes(needle))) {
        score = Math.max(score, partialScore);
      }
    }

    return score;
  }

  /**
   * 为候选接口打一个简单分数，用来做结果排序。
   *
   * 规则刻意保持朴素：
   * - path 直接命中优先级最高
   * - tag / query 次之
   * - 只做启发式排序，不追求复杂相关性模型
   */
  private scoreEntry(
    entry: ApiIndexEntry,
    metadata: SearchMetadata,
    params: {
      query: string;
      path: string;
      pathNeedles: string[];
      queryPathNeedles: string[];
      tag: string;
    }
  ): number {
    let score = 0;
    const { pathAliases, searchText } = metadata;

    // 排序规则尽量保持简单：path 直接命中权重最高，其次是 tag / query 命中。
    if (params.path) {
      score += this.scorePathNeedles(
        pathAliases,
        params.pathNeedles.length > 0 ? params.pathNeedles : [params.path],
        120,
        70
      );
    }

    if (params.tag) {
      if (entry.tags.some((tag) => normalizeForSearch(tag) === params.tag)) {
        score += 50;
      } else if (entry.tags.some((tag) => includesNeedle(tag, params.tag))) {
        score += 25;
      }
    }

    if (params.query) {
      if (searchText.includes(params.query)) {
        score += 100;
      } else {
        score += this.scorePathNeedles(pathAliases, params.queryPathNeedles, 100, 60);
      }

      if (includesNeedle(entry.operationId, params.query)) {
        score += 50;
      }
      if (includesNeedle(entry.summary, params.query)) {
        score += 30;
      }
      if (includesNeedle(entry.description, params.query)) {
        score += 20;
      }
      if (entry.tags.some((tag) => includesNeedle(tag, params.query))) {
        score += 25;
      }
    }

    return score;
  }

  private getSearchMetadata(entry: ApiIndexEntry): SearchMetadata {
    const cached = this.searchMetadata.get(entry);
    if (cached) {
      return cached;
    }

    const moduleSpec = this.moduleSpecs.get(entry.module) ?? {
      module: entry.module,
      displayName: entry.module,
      specUrl: entry.specUrl,
      specType: "unknown" as const,
      rawSpec: {},
      fetchedAt: "",
    };
    const pathAliases = buildPathAliases(entry, moduleSpec);
    const metadata = {
      pathAliases,
      searchText: buildSearchText(entry, pathAliases),
    };
    this.searchMetadata.set(entry, metadata);
    return metadata;
  }

  private rebuildSearchMetadata(): void {
    this.searchMetadata = new WeakMap<ApiIndexEntry, SearchMetadata>();
    for (const entry of this.apiEntries) {
      this.getSearchMetadata(entry);
    }
  }

  /**
   * 汇总当前 refresh 的整体状态，作为 `list_specs` / `refresh_specs` 返回值。
   */
  private buildRefreshResult(): RefreshResult {
    const modules = this.listSpecs();
    const loadedModules = modules.filter((module) => module.status === "loaded").length;
    const failedModules = modules.filter((module) => module.status === "failed").length;
    const totalOperations = modules.reduce(
      (sum, module) => sum + (module.operationCount ?? 0),
      0
    );

    return {
      refreshedAt: this.lastRefreshAt
        ? new Date(this.lastRefreshAt).toISOString()
        : new Date(0).toISOString(),
      resourcesUrl: this.config.swaggerResourcesUrl,
      loadedModules,
      failedModules,
      totalOperations,
      modules,
      errors: this.lastErrors,
    };
  }
}
