import {
  ApiIndexEntry,
  HttpMethod,
  LoadedModuleSpec,
  RefSummary,
} from "./types.js";

const METHODS: HttpMethod[] = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function specType(rawSpec: Record<string, unknown>): LoadedModuleSpec["specType"] {
  if (typeof rawSpec.swagger === "string" && rawSpec.swagger.startsWith("2.")) {
    return "swagger2";
  }

  if (typeof rawSpec.openapi === "string" && rawSpec.openapi.startsWith("3.")) {
    return "openapi3";
  }

  return "unknown";
}

export function detectSpecType(
  rawSpec: Record<string, unknown>
): LoadedModuleSpec["specType"] {
  return specType(rawSpec);
}

export function extractApiEntries(moduleSpec: LoadedModuleSpec): ApiIndexEntry[] {
  const paths = moduleSpec.rawSpec.paths;
  if (!isRecord(paths)) {
    return [];
  }

  const globalConsumes = toStringArray(moduleSpec.rawSpec.consumes);
  const globalProduces = toStringArray(moduleSpec.rawSpec.produces);
  const entries: ApiIndexEntry[] = [];

  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isRecord(pathItemValue)) {
      continue;
    }

    const pathParameters = Array.isArray(pathItemValue.parameters)
      ? pathItemValue.parameters
      : [];
    const pathConsumes = toStringArray(pathItemValue.consumes);
    const pathProduces = toStringArray(pathItemValue.produces);

    for (const method of METHODS) {
      const operationValue = pathItemValue[method];
      if (!isRecord(operationValue)) {
        continue;
      }

      const operationParameters = Array.isArray(operationValue.parameters)
        ? operationValue.parameters
        : [];

      entries.push({
        module: moduleSpec.module,
        method,
        path,
        summary:
          typeof operationValue.summary === "string"
            ? operationValue.summary
            : undefined,
        description:
          typeof operationValue.description === "string"
            ? operationValue.description
            : undefined,
        operationId:
          typeof operationValue.operationId === "string"
            ? operationValue.operationId
            : undefined,
        tags: toStringArray(operationValue.tags),
        specUrl: moduleSpec.specUrl,
        consumes:
          toStringArray(operationValue.consumes).length > 0
            ? toStringArray(operationValue.consumes)
            : pathConsumes.length > 0
              ? pathConsumes
              : globalConsumes,
        produces:
          toStringArray(operationValue.produces).length > 0
            ? toStringArray(operationValue.produces)
            : pathProduces.length > 0
              ? pathProduces
              : globalProduces,
        parameters: [...pathParameters, ...operationParameters],
        requestBody: operationValue.requestBody,
        responses: operationValue.responses,
        operation: operationValue,
      });
    }
  }

  return entries;
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const refValue = value.$ref;
  if (typeof refValue === "string") {
    refs.add(refValue);
  }

  for (const nestedValue of Object.values(value)) {
    collectRefs(nestedValue, refs);
  }
}

function summarizeDefinition(name: string, raw: unknown): RefSummary {
  if (!isRecord(raw)) {
    return {
      ref: name,
      kind: "unknown",
      name,
      raw,
    };
  }

  const propertyKeys = isRecord(raw.properties)
    ? Object.keys(raw.properties)
    : undefined;

  return {
    ref: name,
    kind: "schema",
    name,
    summary:
      typeof raw.description === "string"
        ? raw.description
        : typeof raw.title === "string"
          ? raw.title
          : undefined,
    required: Array.isArray(raw.required)
      ? raw.required.filter((item): item is string => typeof item === "string")
      : undefined,
    propertyKeys,
    raw,
  };
}

function resolveRefRaw(
  spec: Record<string, unknown>,
  ref: string
): { kind: RefSummary["kind"]; name: string; raw: unknown } | undefined {
  if (!ref.startsWith("#/")) {
    return {
      kind: "unknown",
      name: ref,
      raw: undefined,
    };
  }

  const tokens = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const token of tokens) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[token];
  }

  const group = tokens[0] ?? "";
  const name = tokens[tokens.length - 1] ?? ref;

  const kind: RefSummary["kind"] =
    group === "definitions" || group === "schemas" || group === "components"
      ? "schema"
      : group === "parameters"
        ? "parameter"
        : group === "responses"
          ? "response"
          : group === "requestBodies"
            ? "requestBody"
            : "unknown";

  return {
    kind,
    name,
    raw: current,
  };
}

export function collectRelatedRefs(
  entry: ApiIndexEntry,
  rawSpec: Record<string, unknown>
): RefSummary[] {
  const refs = new Set<string>();
  collectRefs(entry.parameters, refs);
  collectRefs(entry.requestBody, refs);
  collectRefs(entry.responses, refs);
  collectRefs(entry.operation, refs);

  return [...refs]
    .map((ref) => {
      const resolved = resolveRefRaw(rawSpec, ref);
      if (!resolved) {
        return undefined;
      }

      const summary = summarizeDefinition(resolved.name, resolved.raw);
      return {
        ...summary,
        ref,
        kind: resolved.kind,
      };
    })
    .filter((item): item is RefSummary => Boolean(item));
}
