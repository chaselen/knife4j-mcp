import { loadConfig } from "./config.js";
import { fetchJson, resolveUrl } from "./http.js";
import { logger } from "./logger.js";
import {
  collectRelatedRefs,
  detectSpecType,
  extractApiEntries,
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

function normalizeModuleName(resource: SwaggerResource): string {
  return (resource.name || resource.location || resource.url || "unknown").trim();
}

function uniqueStringList(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeForSearch(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function includesNeedle(value: string | undefined, needle: string): boolean {
  return normalizeForSearch(value).includes(needle);
}

function buildSearchText(entry: ApiIndexEntry): string {
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

export class SwaggerRegistry {
  private readonly config: SwaggerServerConfig;
  private lastRefreshAt = 0;
  private apiEntries: ApiIndexEntry[] = [];
  private moduleSpecs = new Map<string, LoadedModuleSpec>();
  private moduleStates = new Map<string, ModuleLoadState>();
  private lastErrors: string[] = [];
  private refreshPromise?: Promise<RefreshResult>;

  constructor(config: SwaggerServerConfig = loadConfig()) {
    this.config = config;
  }

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

  async refresh(): Promise<RefreshResult> {
    return this.ensureLoaded(true);
  }

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
    }));
  }

  findApi(params: SearchParams): ApiIndexEntry[] {
    const limit = params.limit && params.limit > 0 ? params.limit : 20;
    const query = normalizeForSearch(params.query);
    const path = normalizeForSearch(params.path);
    const tag = normalizeForSearch(params.tag);
    const module = normalizeForSearch(params.module);
    const method = normalizeForSearch(params.method);

    const scored = this.apiEntries
      .filter((entry) => {
        if (module && normalizeForSearch(entry.module) !== module) {
          return false;
        }

        if (method && normalizeForSearch(entry.method) !== method) {
          return false;
        }

        if (path && !includesNeedle(entry.path, path)) {
          return false;
        }

        if (
          tag &&
          !entry.tags.some((entryTag) => includesNeedle(entryTag, tag))
        ) {
          return false;
        }

        if (!query) {
          return true;
        }

        return buildSearchText(entry).includes(query);
      })
      .map((entry) => ({ entry, score: this.scoreEntry(entry, params) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.entry);

    return scored;
  }

  getApiDetail(moduleName: string, path: string, method: string): Record<string, unknown> | null {
    const normalizedModule = normalizeForSearch(moduleName);
    const normalizedPath = path.trim();
    const normalizedMethod = normalizeForSearch(method);

    const entry = this.apiEntries.find(
      (candidate) =>
        normalizeForSearch(candidate.module) === normalizedModule &&
        candidate.path === normalizedPath &&
        candidate.method === normalizedMethod
    );

    if (!entry) {
      return null;
    }

    const moduleSpec = this.moduleSpecs.get(entry.module);
    const relatedRefs = moduleSpec
      ? collectRelatedRefs(entry, moduleSpec.rawSpec)
      : [];

    return {
      module: entry.module,
      method: entry.method,
      path: entry.path,
      summary: entry.summary,
      description: entry.description,
      tags: entry.tags,
      consumes: entry.consumes ?? [],
      produces: entry.produces ?? [],
      parameters: entry.parameters,
      requestBody: entry.requestBody ?? null,
      responses: entry.responses ?? {},
      relatedRefs,
      rawOperation: entry.operation,
      specUrl: entry.specUrl,
    };
  }

  getStatus(): RefreshResult {
    return this.buildRefreshResult();
  }

  private async reload(): Promise<RefreshResult> {
    logger.info("Refreshing swagger resources", {
      resourcesUrl: this.config.swaggerResourcesUrl,
    });

    const resourcesUrl = resolveUrl(
      this.config.swaggerResourcesUrl,
      this.config,
      this.config.swaggerBaseUrl
    );

    const resources = await fetchJson<SwaggerResource[]>(resourcesUrl, this.config);
    const filteredResources = this.filterResources(resources);

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

        const specUrl = resolveUrl(resourceUrl, this.config, resourcesUrl);

        try {
          const rawSpec = await fetchJson<Record<string, unknown>>(specUrl, this.config);
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
          const message = String(error);
          logger.warn("Failed to load module spec", { module, specUrl, error: message });
          errors.push(`${module}: ${message}`);
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

  private scoreEntry(entry: ApiIndexEntry, params: SearchParams): number {
    let score = 0;
    const normalizedQuery = normalizeForSearch(params.query);
    const normalizedPath = normalizeForSearch(params.path);
    const normalizedTag = normalizeForSearch(params.tag);

    if (normalizedPath) {
      if (normalizeForSearch(entry.path) === normalizedPath) {
        score += 120;
      } else if (includesNeedle(entry.path, normalizedPath)) {
        score += 70;
      }
    }

    if (normalizedTag) {
      if (entry.tags.some((tag) => normalizeForSearch(tag) === normalizedTag)) {
        score += 50;
      } else if (entry.tags.some((tag) => includesNeedle(tag, normalizedTag))) {
        score += 25;
      }
    }

    if (normalizedQuery) {
      if (includesNeedle(entry.path, normalizedQuery)) {
        score += 100;
      }
      if (includesNeedle(entry.operationId, normalizedQuery)) {
        score += 50;
      }
      if (includesNeedle(entry.summary, normalizedQuery)) {
        score += 30;
      }
      if (includesNeedle(entry.description, normalizedQuery)) {
        score += 20;
      }
      if (entry.tags.some((tag) => includesNeedle(tag, normalizedQuery))) {
        score += 25;
      }
    }

    return score;
  }

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
