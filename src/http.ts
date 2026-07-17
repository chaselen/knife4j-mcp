import { logger } from "./logger.js";
import { SwaggerServerConfig } from "./types.js";

function buildHeaders(config: SwaggerServerConfig): Headers {
  const headers = new Headers(config.headers);
  headers.set("accept", "application/json");

  if (config.basicAuth) {
    const encoded = Buffer.from(config.basicAuth, "utf8").toString("base64");
    headers.set("authorization", `Basic ${encoded}`);
  }

  return headers;
}

export function resolveUrl(
  input: string | undefined,
  config: SwaggerServerConfig,
  fallbackBase?: string
): string {
  if (!input) {
    throw new Error("Cannot resolve empty URL");
  }

  try {
    return new URL(input).toString();
  } catch {
    const base = fallbackBase ?? config.swaggerBaseUrl ?? config.swaggerResourcesUrl;
    return new URL(input, base).toString();
  }
}

export async function fetchJson<T>(
  url: string,
  config: SwaggerServerConfig
): Promise<T> {
  const headers = buildHeaders(config);
  logger.debug("Fetching JSON", { url });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`Network error for ${url}: ${String(error)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} for ${url}${body ? `: ${body.slice(0, 300)}` : ""}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    logger.warn("Unexpected content type when fetching JSON", {
      url,
      contentType,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${String(error)}`);
  }
}
