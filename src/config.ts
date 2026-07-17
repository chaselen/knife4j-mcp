import { SwaggerServerConfig } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_FETCH_CONCURRENCY = 8;
const DEFAULT_EXTERNAL_REF_LIMIT = 32;

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

function parseRequestTimeout(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("SWAGGER_REQUEST_TIMEOUT_MS must be a positive number");
  }

  return parsed;
}

function parseFetchConcurrency(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_FETCH_CONCURRENCY;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new Error(
      "SWAGGER_FETCH_CONCURRENCY must be an integer between 1 and 100"
    );
  }

  return parsed;
}

function parseExternalRefLimit(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_EXTERNAL_REF_LIMIT;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 200) {
    throw new Error(
      "SWAGGER_EXTERNAL_REF_LIMIT must be an integer between 0 and 200"
    );
  }

  return parsed;
}

function parseExternalRefOrigins(
  rawValue: string | undefined
): Set<string> | undefined {
  if (!rawValue) {
    return undefined;
  }

  const origins = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
          "SWAGGER_EXTERNAL_REF_ORIGINS only accepts HTTP(S) origins"
        );
      }
      return url.origin;
    });

  return origins.length > 0 ? new Set(origins) : undefined;
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
    requestTimeoutMs: parseRequestTimeout(env.SWAGGER_REQUEST_TIMEOUT_MS),
    fetchConcurrency: parseFetchConcurrency(env.SWAGGER_FETCH_CONCURRENCY),
    externalRefLimit: parseExternalRefLimit(env.SWAGGER_EXTERNAL_REF_LIMIT),
    externalRefOrigins: parseExternalRefOrigins(
      env.SWAGGER_EXTERNAL_REF_ORIGINS
    ),
  };
}
