import {
  ApiIndexEntry,
  ExpandedParameter,
  ExpandedSchemaNode,
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

function collectNestedRefsFromSchema(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedRefsFromSchema(item, refs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const refValue = value.$ref;
  if (typeof refValue === "string") {
    if (refs.has(refValue)) {
      return;
    }

    refs.add(refValue);
    return;
  }

  if (isRecord(value.properties)) {
    for (const propertyValue of Object.values(value.properties)) {
      collectNestedRefsFromSchema(propertyValue, refs);
    }
  }

  if ("items" in value) {
    collectNestedRefsFromSchema(value.items, refs);
  }

  if ("additionalProperties" in value) {
    collectNestedRefsFromSchema(value.additionalProperties, refs);
  }

  if (Array.isArray(value.allOf)) {
    for (const item of value.allOf) {
      collectNestedRefsFromSchema(item, refs);
    }
  }

  if (Array.isArray(value.oneOf)) {
    for (const item of value.oneOf) {
      collectNestedRefsFromSchema(item, refs);
    }
  }

  if (Array.isArray(value.anyOf)) {
    for (const item of value.anyOf) {
      collectNestedRefsFromSchema(item, refs);
    }
  }

  if (isRecord(value.not)) {
    collectNestedRefsFromSchema(value.not, refs);
  }
}

function collectDeepRefs(
  spec: Record<string, unknown>,
  rootRefs: Iterable<string>
): Set<string> {
  const visited = new Set<string>();
  const queue = [...rootRefs];

  while (queue.length > 0) {
    const ref = queue.shift();
    if (!ref || visited.has(ref)) {
      continue;
    }

    visited.add(ref);
    const resolved = resolveRefRaw(spec, ref);
    if (!resolved) {
      continue;
    }

    const nestedRefs = new Set<string>();
    collectNestedRefsFromSchema(resolved.raw, nestedRefs);
    for (const nestedRef of nestedRefs) {
      if (!visited.has(nestedRef)) {
        queue.push(nestedRef);
      }
    }
  }

  return visited;
}

function mergeObjectNodes(nodes: ExpandedSchemaNode[]): ExpandedSchemaNode {
  const mergedProperties: Record<string, ExpandedSchemaNode> = {};
  const required = new Set<string>();
  let description: string | undefined;
  let nullable = false;
  let raw: unknown;
  let additionalProperties: ExpandedSchemaNode["additionalProperties"];

  for (const node of nodes) {
    if (node.description && !description) {
      description = node.description;
    }
    if (node.nullable) {
      nullable = true;
    }
    if (node.raw !== undefined && raw === undefined) {
      raw = node.raw;
    }
    if (node.required) {
      for (const key of node.required) {
        required.add(key);
      }
    }
    if (node.additionalProperties !== undefined && additionalProperties === undefined) {
      additionalProperties = node.additionalProperties;
    }
    if (node.properties) {
      Object.assign(mergedProperties, node.properties);
    }
  }

  return {
    kind: "object",
    type: "object",
    description,
    nullable: nullable || undefined,
    required: required.size > 0 ? [...required] : undefined,
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
    additionalProperties,
    raw,
  };
}

function resolveSchemaNode(
  spec: Record<string, unknown>,
  schema: unknown,
  stack: string[] = []
): ExpandedSchemaNode {
  if (!isRecord(schema)) {
    return {
      kind: "unknown",
      raw: schema,
    };
  }

  const description =
    typeof schema.description === "string"
      ? schema.description
      : typeof schema.title === "string"
        ? schema.title
        : undefined;
  const nullable =
    schema.nullable === true ||
    (Array.isArray(schema.type) && schema.type.includes("null"));
  const format = typeof schema.format === "string" ? schema.format : undefined;

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const resolved = resolveRefRaw(spec, ref);
    if (!resolved) {
      return {
        kind: "ref",
        ref,
        refName: ref.split("/").pop() ?? ref,
        description,
        nullable: nullable || undefined,
        raw: schema,
      };
    }

    if (stack.includes(ref)) {
      return {
        kind: "ref",
        ref,
        refName: resolved.name,
        description: description ?? (typeof resolved.raw === "object" ? undefined : undefined),
        nullable: nullable || undefined,
        raw: resolved.raw,
      };
    }

    const expanded = resolveSchemaNode(spec, resolved.raw, [...stack, ref]);
    return {
      ...expanded,
      ref,
      refName: resolved.name,
      description: expanded.description ?? description,
      nullable: expanded.nullable ?? (nullable || undefined),
      raw: expanded.raw ?? resolved.raw,
    };
  }

  if (Array.isArray(schema.allOf)) {
    const variants = schema.allOf.map((item) => resolveSchemaNode(spec, item, stack));
    const objectCandidates = variants.filter(
      (item) => item.kind === "object" || item.properties || item.additionalProperties
    );
    if (objectCandidates.length === variants.length && variants.length > 0) {
      const merged = mergeObjectNodes(objectCandidates);
      return {
        ...merged,
        description: merged.description ?? description,
        nullable: merged.nullable ?? (nullable || undefined),
        raw: schema,
      };
    }

    return {
      kind: "intersection",
      description,
      nullable: nullable || undefined,
      variants,
      raw: schema,
    };
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const source: unknown[] = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : [];
    return {
      kind: "union",
      description,
      nullable: nullable || undefined,
      variants: source.map((item) => resolveSchemaNode(spec, item, stack)),
      raw: schema,
    };
  }

  if (Array.isArray(schema.enum)) {
    return {
      kind: "enum",
      type: typeof schema.type === "string" ? schema.type : undefined,
      format,
      description,
      nullable: nullable || undefined,
      enumValues: [...schema.enum],
      raw: schema,
    };
  }

  const typeValue = typeof schema.type === "string" ? schema.type : undefined;
  if (typeValue === "array" || "items" in schema) {
    return {
      kind: "array",
      type: "array",
      format,
      description,
      nullable: nullable || undefined,
      items: resolveSchemaNode(spec, schema.items, stack),
      raw: schema,
    };
  }

  if (
    typeValue === "object" ||
    isRecord(schema.properties) ||
    "additionalProperties" in schema
  ) {
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [
            key,
            resolveSchemaNode(spec, value, stack),
          ])
        )
      : undefined;

    let additionalProperties: ExpandedSchemaNode["additionalProperties"];
    if (typeof schema.additionalProperties === "boolean") {
      additionalProperties = schema.additionalProperties;
    } else if (schema.additionalProperties !== undefined) {
      additionalProperties = resolveSchemaNode(
        spec,
        schema.additionalProperties,
        stack
      );
    }

    return {
      kind: "object",
      type: "object",
      format,
      description,
      nullable: nullable || undefined,
      required: Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : undefined,
      properties,
      additionalProperties,
      raw: schema,
    };
  }

  if (typeValue) {
    return {
      kind: "primitive",
      type: typeValue,
      format,
      description,
      nullable: nullable || undefined,
      raw: schema,
    };
  }

  return {
    kind: "unknown",
    description,
    nullable: nullable || undefined,
    raw: schema,
  };
}

export function resolveParameter(
  parameter: unknown,
  rawSpec: Record<string, unknown>
): ExpandedParameter {
  const resolvedParameter =
    isRecord(parameter) && typeof parameter.$ref === "string"
      ? resolveRefRaw(rawSpec, parameter.$ref)?.raw ?? parameter
      : parameter;

  if (!isRecord(resolvedParameter)) {
    return {
      schema: null,
      raw: parameter,
    };
  }

  const schema =
    resolvedParameter.schema !== undefined
      ? resolveSchemaNode(rawSpec, resolvedParameter.schema)
      : resolveSchemaNode(rawSpec, resolvedParameter);

  return {
    name:
      typeof resolvedParameter.name === "string" ? resolvedParameter.name : undefined,
    in: typeof resolvedParameter.in === "string" ? resolvedParameter.in : undefined,
    required:
      typeof resolvedParameter.required === "boolean"
        ? resolvedParameter.required
        : undefined,
    description:
      typeof resolvedParameter.description === "string"
        ? resolvedParameter.description
        : undefined,
    schema,
    raw: resolvedParameter,
  };
}

export function resolveRequestBody(
  requestBody: unknown,
  rawSpec: Record<string, unknown>
): Record<string, unknown> | null {
  if (!isRecord(requestBody)) {
    return null;
  }

  const resolvedRequestBody =
    typeof requestBody.$ref === "string"
      ? resolveRefRaw(rawSpec, requestBody.$ref)?.raw ?? requestBody
      : requestBody;

  if (!isRecord(resolvedRequestBody)) {
    return null;
  }

  if (isRecord(resolvedRequestBody.content)) {
    const content = Object.fromEntries(
      Object.entries(resolvedRequestBody.content).map(([mediaType, mediaValue]) => {
        const schema = isRecord(mediaValue) ? mediaValue.schema : undefined;
        return [
          mediaType,
          {
            schema: schema ? resolveSchemaNode(rawSpec, schema) : null,
            raw: mediaValue,
          },
        ];
      })
    );

    return {
      description:
        typeof resolvedRequestBody.description === "string"
          ? resolvedRequestBody.description
          : undefined,
      required:
        typeof resolvedRequestBody.required === "boolean"
          ? resolvedRequestBody.required
          : undefined,
      content,
      raw: resolvedRequestBody,
    };
  }

  return {
    description:
      typeof resolvedRequestBody.description === "string"
        ? resolvedRequestBody.description
        : undefined,
    required:
      typeof resolvedRequestBody.required === "boolean"
        ? resolvedRequestBody.required
        : undefined,
    schema: resolveSchemaNode(rawSpec, resolvedRequestBody.schema ?? resolvedRequestBody),
    raw: resolvedRequestBody,
  };
}

export function resolveResponses(
  responses: unknown,
  rawSpec: Record<string, unknown>
): Record<string, unknown> {
  if (!isRecord(responses)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(responses).map(([statusCode, responseValue]) => {
      const resolvedResponse =
        isRecord(responseValue) && typeof responseValue.$ref === "string"
          ? resolveRefRaw(rawSpec, responseValue.$ref)?.raw ?? responseValue
          : responseValue;

      if (!isRecord(resolvedResponse)) {
        return [statusCode, { raw: responseValue }];
      }

      if (isRecord(resolvedResponse.content)) {
        const content = Object.fromEntries(
          Object.entries(resolvedResponse.content).map(([mediaType, mediaValue]) => {
            const schema = isRecord(mediaValue) ? mediaValue.schema : undefined;
            return [
              mediaType,
              {
                schema: schema ? resolveSchemaNode(rawSpec, schema) : null,
                raw: mediaValue,
              },
            ];
          })
        );

        return [
          statusCode,
          {
            description:
              typeof resolvedResponse.description === "string"
                ? resolvedResponse.description
                : undefined,
            content,
            raw: resolvedResponse,
          },
        ];
      }

      return [
        statusCode,
        {
          description:
            typeof resolvedResponse.description === "string"
              ? resolvedResponse.description
              : undefined,
          schema:
            resolvedResponse.schema !== undefined
              ? resolveSchemaNode(rawSpec, resolvedResponse.schema)
              : null,
          raw: resolvedResponse,
        },
      ];
    })
  );
}

export function collectExpandedRelatedRefs(
  entry: ApiIndexEntry,
  rawSpec: Record<string, unknown>
): RefSummary[] {
  const directRefs = new Set<string>();
  collectRefs(entry.parameters, directRefs);
  collectRefs(entry.requestBody, directRefs);
  collectRefs(entry.responses, directRefs);
  collectRefs(entry.operation, directRefs);

  const expandedRefs = collectDeepRefs(rawSpec, directRefs);

  return [...expandedRefs]
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
