import { SwaggerServerConfig } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function parseHeaders(rawValue: string | undefined): Record<string, string> {
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string | number | boolean] => {
          const value = entry[1];
          return ["string", "number", "boolean"].includes(typeof value);
        })
        .map(([key, value]) => [key, String(value)])
    );
  } catch (error) {
    throw new Error(`Invalid SWAGGER_HEADERS JSON: ${String(error)}`);
  }
}

function parseAllowlist(rawValue: string | undefined): Set<string> | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? new Set(values) : undefined;
}

function parseCacheTtl(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("CACHE_TTL_MS must be a non-negative number");
  }

  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SwaggerServerConfig {
  const swaggerResourcesUrl = env.SWAGGER_RESOURCES_URL?.trim();
  if (!swaggerResourcesUrl) {
    throw new Error("Missing required env: SWAGGER_RESOURCES_URL");
  }

  return {
    swaggerResourcesUrl,
    swaggerBaseUrl: env.SWAGGER_BASE_URL?.trim() || undefined,
    basicAuth: env.SWAGGER_BASIC_AUTH?.trim() || undefined,
    headers: parseHeaders(env.SWAGGER_HEADERS),
    moduleAllowlist: parseAllowlist(env.SWAGGER_MODULE_ALLOWLIST),
    cacheTtlMs: parseCacheTtl(env.CACHE_TTL_MS),
  };
}
