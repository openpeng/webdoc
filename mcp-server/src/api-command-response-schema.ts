/**
 * WebPilot API 命令集 —— 响应体 schema 推导、字段裁剪与脱敏（**无 IO 纯函数管线**）。
 *
 * 硬约束：不 import node:fs、不读环境变量、不读 Date.now()、不依赖运行时单例。
 *
 * 安全纪律（AC-04 / AC-20）：
 *  - deriveResponseSchema() 只输出「字段名 + 类型 + 是否数组 / 分页 / 敏感」，
 *    **样本值绝不出现在任何返回值、warnings、日志字符串里**；
 *  - 样本 bodyText 只在函数内部的局部变量解析，函数返回即不再持有引用；
 *  - redactAndProject() 的 redactedFields[] 只放字段路径，绝不回显原值。
 */
import {
  MAX_SCHEMA_DEPTH, MAX_ARRAY_SAMPLES, MAX_BODY_CHARS_DEFAULT, MAX_BODY_CHARS_MIN,
  MAX_BODY_CHARS_MAX, MAX_RESPONSE_FIELDS, MAX_SCHEMA_FIELDS, REDACTED_VALUE,
  RESPONSE_FIELD_PATTERN, PAGINATION_FIELD_NAMES,
} from "./api-command-types.js";
import { isSensitiveFieldName, inferValueType } from "./api-command-normalize.js";
import type {
  ResponseBodySample, ResponseSchema, SchemaField, SchemaFieldType,
  ProjectResult,
} from "./api-command-types.js";

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarType(value: unknown): SchemaFieldType {
  if (value === null || value === undefined) return "null";
  return inferValueType(value) as SchemaFieldType;
}

function lastSegmentName(path: string): string {
  const segments = path.split(".");
  const last = segments[segments.length - 1] || "";
  return last.replace(/\[\]$/, "");
}

function stripMarkers(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPaginationField(path: string): boolean {
  const name = stripMarkers(lastSegmentName(path));
  if (!name) return false;
  return (PAGINATION_FIELD_NAMES as readonly string[]).some((candidate) => {
    const key = stripMarkers(candidate);
    return name === key || name.endsWith(key);
  });
}

/** 合并同路径字段：类型冲突时保留首个非 null 类型，布尔标记取 OR。 */
function putField(out: Map<string, SchemaField>, field: SchemaField): void {
  const existing = out.get(field.path);
  if (!existing) { out.set(field.path, { ...field }); return; }
  if (existing.type === "null" && field.type !== "null") existing.type = field.type;
  existing.array = existing.array || field.array;
  existing.isPagination = existing.isPagination || field.isPagination;
  existing.redacted = existing.redacted || field.redacted;
}

/** 生成一个全新的空 schema（每次调用返回新对象，避免共享可变引用）。 */
export function emptyResponseSchema(): ResponseSchema {
  return { fields: [], depthLimited: false, sampleCount: 0 };
}

/**
 * 递归遍历一个 JSON 样本，只把**字段名与类型**写进 out。
 * 深度超过 MAX_SCHEMA_DEPTH 即停止下钻并回调 onDepthLimited；
 * 数组最多检查前 MAX_ARRAY_SAMPLES 个元素。绝不写入任何样本值。
 */
function walk(
  value: unknown,
  path: string,
  depth: number,
  out: Map<string, SchemaField>,
  onDepthLimited: () => void,
): void {
  if (depth > MAX_SCHEMA_DEPTH) { onDepthLimited(); return; }

  if (Array.isArray(value)) {
    const arrayPath = path ? `${path}[]` : "[]";
    if (value.length === 0) {
      putField(out, {
        path: arrayPath, type: "array", array: true,
        isPagination: isPaginationField(path), redacted: isSensitiveFieldName(lastSegmentName(path)),
      });
      return;
    }
    for (const item of value.slice(0, MAX_ARRAY_SAMPLES)) {
      walk(item, arrayPath, depth + 1, out, onDepthLimited);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!key) continue;
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(child) || isPlainObject(child)) {
        walk(child, childPath, depth + 1, out, onDepthLimited);
      } else {
        putField(out, {
          path: childPath,
          type: scalarType(child),
          array: childPath.includes("[]"),
          isPagination: isPaginationField(childPath),
          redacted: isSensitiveFieldName(key),
        });
      }
    }
    return;
  }

  if (path) {
    putField(out, {
      path,
      type: scalarType(value),
      array: path.includes("[]"),
      isPagination: isPaginationField(path),
      redacted: isSensitiveFieldName(lastSegmentName(path)),
    });
  }
}

// ---------------------------------------------------------------------------
// 公开纯函数
// ---------------------------------------------------------------------------

/**
 * 从 Q8 限量响应体样本推导 schema。
 * 只输出字段名 / 类型 / 数组 / 分页 / 敏感标记；解析失败或空样本直接跳过。
 * 返回后不再持有任何 sample.bodyText 引用（样本值不落盘、不进报告）。
 */
export function deriveResponseSchema(samples: ResponseBodySample[]): ResponseSchema {
  if (!Array.isArray(samples) || samples.length === 0) return emptyResponseSchema();
  const fields = new Map<string, SchemaField>();
  let depthLimited = false;
  let sampleCount = 0;
  const onDepthLimited = (): void => { depthLimited = true; };
  for (const sample of samples) {
    if (!sample || typeof sample.bodyText !== "string" || !sample.bodyText.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(sample.bodyText);
    } catch {
      // 样本被 64KB 截断导致 JSON 不完整：跳过，绝不猜测或回显内容。
      continue;
    }
    sampleCount += 1;
    walk(parsed, "", 0, fields, onDepthLimited);
    // parsed 是本轮局部变量，循环结束后不再持有任何样本值引用。
  }
  return {
    fields: [...fields.values()].slice(0, MAX_SCHEMA_FIELDS),
    depthLimited,
    sampleCount,
  };
}

/** 从 schema 生成响应字段白名单：排除敏感字段与非标量中间节点，绝不含任何值。 */
export function deriveResponseFields(schema: ResponseSchema): string[] {
  if (!schema || !Array.isArray(schema.fields)) return [];
  const out: string[] = [];
  for (const field of schema.fields) {
    if (!field || typeof field.path !== "string") continue;
    if (field.redacted === true) continue;
    if (field.type === "object" || field.type === "array") continue;
    if (!RESPONSE_FIELD_PATTERN.test(field.path)) continue;
    out.push(field.path);
  }
  return [...new Set(out)].slice(0, MAX_RESPONSE_FIELDS);
}

/** clamp maxBodyChars 到 1000..500000（PRD 5.5）。 */
export function clampBodyChars(value: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : MAX_BODY_CHARS_DEFAULT;
  return Math.min(MAX_BODY_CHARS_MAX, Math.max(MAX_BODY_CHARS_MIN, numeric));
}

/** clamp 数组示例条数到 1..MAX_ARRAY_SAMPLES（Q8 数组示例 ≤5）。 */
export function clampArraySamples(value?: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value as number) : MAX_ARRAY_SAMPLES;
  return Math.min(MAX_ARRAY_SAMPLES, Math.max(1, numeric));
}

function segmentKey(segment: string): { key: string; isArray: boolean } {
  const isArray = segment.endsWith("[]");
  return { key: isArray ? segment.slice(0, -2) : segment, isArray };
}

/**
 * 按白名单点路径提取单个值。
 * 数组段取前 arrayLimit 条，超出回调 onTruncate；命中敏感字段名则统一 [REDACTED]。
 * 只返回字段名与脱敏占位，绝不回显被掩码的原值。
 */
function extractPath(
  current: unknown,
  segments: string[],
  index: number,
  arrayLimit: number,
  redactedFields: string[],
  fullPath: string,
  onTruncate: () => void,
): unknown {
  if (!isPlainObject(current) || index >= segments.length) return undefined;
  const { key, isArray } = segmentKey(segments[index]);
  const raw = current[key];
  if (raw === undefined) return undefined;
  const isLast = index === segments.length - 1;

  if (isArray) {
    if (!Array.isArray(raw)) return undefined;
    if (raw.length > arrayLimit) onTruncate();
    const items: unknown[] = [];
    for (const item of raw.slice(0, arrayLimit)) {
      const value = isLast
        ? (typeof item === "object" && item !== null ? undefined : item)
        : extractPath(item, segments, index + 1, arrayLimit, redactedFields, fullPath, onTruncate);
      if (value !== undefined) items.push(value);
    }
    if (isSensitiveFieldName(key)) {
      redactedFields.push(fullPath);
      return items.length > 0 ? items.map(() => REDACTED_VALUE) : undefined;
    }
    return items.length > 0 ? items : undefined;
  }

  if (isLast) {
    if (typeof raw === "object" && raw !== null) return undefined;
    if (isSensitiveFieldName(key)) {
      redactedFields.push(fullPath);
      return REDACTED_VALUE;
    }
    return raw;
  }
  return extractPath(raw, segments, index + 1, arrayLimit, redactedFields, fullPath, onTruncate);
}

/** 把提取到的值写回结果对象的对应路径（支持 [] 数组段）。 */
function setAtPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  if (segments.length === 0 || value === undefined) return;
  const { key, isArray } = segmentKey(segments[0]);
  if (segments.length === 1) {
    target[key] = value;
    return;
  }
  if (isArray) {
    if (!Array.isArray(value)) return;
    const existing = Array.isArray(target[key]) ? target[key] as Array<Record<string, unknown>> : [];
    // 值已是结果数组，逐元素合并剩余路径。
    for (let i = 0; i < value.length; i += 1) {
      const child: Record<string, unknown> = existing[i] || {};
      const remaining = segments.slice(1);
      const subValue = (value as unknown[])[i];
      if (remaining.length === 1) {
        const { key: leafKey } = segmentKey(remaining[0]);
        if (subValue !== undefined) child[leafKey] = subValue;
      } else {
        setAtPath(child, remaining, subValue);
      }
      existing[i] = child;
    }
    target[key] = existing;
    return;
  }
  const child: Record<string, unknown> = isPlainObject(target[key]) ? target[key] as Record<string, unknown> : {};
  setAtPath(child, segments.slice(1), value);
  target[key] = child;
}

/**
 * 响应白名单裁剪 + 敏感字段 [REDACTED] + maxBodyChars 截断。
 * - fields 为空 → 返回空对象（fail-closed，不泄露未授权字段）。
 * - 数组示例受 maxArraySamples 限制，超出标 truncated:true。
 * - 序列化后超长 → 返回截断后的字符串并标 truncated:true。
 * - redactedFields[] 只放字段路径，绝不含原值。
 */
export function redactAndProject(
  data: unknown,
  fields: string[],
  maxBodyChars: number,
  maxArraySamples?: number,
): ProjectResult {
  const limit = clampBodyChars(maxBodyChars);
  const arrayLimit = clampArraySamples(maxArraySamples);
  const redactedFields: string[] = [];
  let truncated = false;
  const onTruncate = (): void => { truncated = true; };
  const paths = (Array.isArray(fields) ? fields : [])
    .filter((field): field is string => typeof field === "string" && RESPONSE_FIELD_PATTERN.test(field))
    .slice(0, MAX_RESPONSE_FIELDS);

  const projectObject = (source: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const path of paths) {
      const segments = path.split(".");
      const value = extractPath(source, segments, 0, arrayLimit, redactedFields, path, onTruncate);
      if (value !== undefined) setAtPath(out, segments, value);
    }
    return out;
  };

  // 无白名单 = 不回显内容（安全默认），但必须保留响应的**形状**：
  // 列表接口若也回 `{}`，调用方会误判成「接口没数据」。
  let projected: unknown;
  if (paths.length === 0) {
    projected = Array.isArray(data) ? [] : {};
  } else if (isPlainObject(data)) {
    projected = projectObject(data);
  } else if (Array.isArray(data)) {
    // 顶层数组（列表接口最常见形态）：逐元素投影，保留数组形状与顺序。
    // 曾经只处理 isPlainObject，导致 /pet/findByStatus 这类接口执行后恒返回 {}。
    const items = data.slice(0, arrayLimit);
    if (data.length > items.length) truncated = true;
    projected = items.map((item) => (isPlainObject(item) ? projectObject(item) : item));
  } else {
    projected = {};
  }

  let text: string;
  try { text = JSON.stringify(projected); } catch { text = "{}"; }
  if (typeof text !== "string") text = "{}";
  if (text.length > limit) {
    return { data: text.slice(0, limit), truncated: true, redactedFields: [...new Set(redactedFields)] };
  }
  return { data: projected, truncated, redactedFields: [...new Set(redactedFields)] };
}

/**
 * 漂移检测，返回**差异描述**（只含字段名与类型名，绝不含值）。
 * expected 为空 schema（sampleCount=0）时视为无基线，返回空数组，避免误判。
 */
export function describeSchemaDrift(actual: ResponseSchema, expected: ResponseSchema): string[] {
  const differences: string[] = [];
  const a = actual && Array.isArray(actual.fields) ? actual.fields : [];
  const e = expected && Array.isArray(expected.fields) ? expected.fields : [];
  if (e.length === 0) return differences;
  const aByPath = new Map(a.filter((f) => f.redacted !== true).map((f) => [f.path, f.type]));
  const eByPath = new Map(e.filter((f) => f.redacted !== true).map((f) => [f.path, f.type]));
  for (const [path, type] of eByPath) {
    const actualType = aByPath.get(path);
    if (actualType === undefined) differences.push(`缺少字段 ${path}`);
    else if (actualType !== type) differences.push(`字段 ${path} 类型由 ${type} 变为 ${actualType}`);
  }
  return differences.slice(0, 20);
}

/**
 * 结构是否一致（true = 无漂移）。service 层据 false 标 drifted 并进 needsReview，
 * 不自动禁用命令。参数顺序：actual = 本次响应推导，expected = 命令中记录的 schema。
 */
export function compareSchema(actual: ResponseSchema, expected: ResponseSchema): boolean {
  return describeSchemaDrift(actual, expected).length === 0;
}
