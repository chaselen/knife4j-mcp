import { fetchJson } from "./http.js";
import { SwaggerServerConfig } from "./types.js";

const EXTERNAL_DOCUMENTS_KEY = "x-knife4j-mcp-external-documents";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function cloneDocument(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function splitReference(ref: string, baseUrl: string): {
  documentUrl: string;
  fragment: string;
} {
  const resolved = new URL(ref, baseUrl);
  const fragment = resolved.hash;
  resolved.hash = "";
  return { documentUrl: resolved.toString(), fragment };
}

function internalReference(documentUrl: string, fragment: string): string {
  const pointer = fragment.startsWith("#/") ? fragment.slice(1) : "";
  return `#/${EXTERNAL_DOCUMENTS_KEY}/${escapePointerToken(documentUrl)}${pointer}`;
}

/**
 * 拉取并内联跨文件 `$ref`，将其改写成本地 JSON Pointer。
 *
 * 只处理 JSON 文档，设置数量上限以避免异常文档无限扩张。
 */
export async function bundleExternalRefs(
  source: Record<string, unknown>,
  sourceUrl: string,
  config: SwaggerServerConfig
): Promise<Record<string, unknown>> {
  const root = cloneDocument(source);
  if (config.externalRefLimit === 0) {
    return root;
  }

  const rootDocumentUrl = splitReference(sourceUrl, sourceUrl).documentUrl;
  const rootOrigin = new URL(rootDocumentUrl).origin;
  const documents = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, Promise<Record<string, unknown>>>();
  const rewrittenDocuments = new Set<string>();

  async function loadDocument(url: string): Promise<Record<string, unknown>> {
    const existing = documents.get(url);
    if (existing) {
      return existing;
    }

    const inFlight = pending.get(url);
    if (inFlight) {
      return inFlight;
    }

    if (documents.size + pending.size >= config.externalRefLimit) {
      throw new Error(
        `External $ref document limit exceeded (${config.externalRefLimit})`
      );
    }

    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`External $ref uses unsupported protocol: ${target.protocol}`);
    }
    if (
      target.origin !== rootOrigin &&
      !config.externalRefOrigins?.has(target.origin)
    ) {
      throw new Error(
        `Cross-origin external $ref is not allowed: ${target.origin}`
      );
    }

    const promise = fetchJson<unknown>(url, config).then((value) => {
      if (!isRecord(value)) {
        throw new Error(`External $ref document ${url} must be a JSON object`);
      }
      const cloned = cloneDocument(value);
      documents.set(url, cloned);
      return cloned;
    });
    pending.set(url, promise);

    try {
      return await promise;
    } finally {
      pending.delete(url);
    }
  }

  async function rewrite(value: unknown, currentUrl: string): Promise<void> {
    if (Array.isArray(value)) {
      await Promise.all(value.map((item) => rewrite(item, currentUrl)));
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    if (
      typeof value.$ref === "string" &&
      !(currentUrl === rootDocumentUrl && value.$ref.startsWith("#"))
    ) {
      const { documentUrl, fragment } = splitReference(value.$ref, currentUrl);
      if (documentUrl === rootDocumentUrl) {
        value.$ref = fragment || "#";
      } else {
        const document = await loadDocument(documentUrl);
        value.$ref = internalReference(documentUrl, fragment);
        await rewriteDocument(document, documentUrl);
      }
    }

    await Promise.all(
      Object.entries(value)
        .filter(([key]) => key !== EXTERNAL_DOCUMENTS_KEY)
        .map(([, nested]) => rewrite(nested, currentUrl))
    );
  }

  async function rewriteDocument(
    document: Record<string, unknown>,
    documentUrl: string
  ): Promise<void> {
    if (rewrittenDocuments.has(documentUrl)) {
      return;
    }
    rewrittenDocuments.add(documentUrl);
    await rewrite(document, documentUrl);
  }

  await rewriteDocument(root, rootDocumentUrl);
  if (documents.size > 0) {
    root[EXTERNAL_DOCUMENTS_KEY] = Object.fromEntries(documents);
  }
  return root;
}
