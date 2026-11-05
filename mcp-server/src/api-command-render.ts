/**
 * WebPilot API 命令集 —— 参数校验 + `{{param}}` 渲染（**无 IO 纯函数**）。
 *
 * 硬约束：不 import node:fs、不读环境变量、不读 Date.now()、不依赖运行时单例。
 * 只消费缓存中的 ApiCommand 与调用方提供的 params，产出可直接下发的最终
 * url / method / body；任何错误都以 RenderError(code: ApiErrorCode) 抛出，
 * 由编排层转成结构化 ExecuteResult.error，**绝不发请求**（AC-08 / AC-21）。
 *
 * 严格区分：pathTemplate 的 `{id}` 只作结构标识；urlTemplate / bodyTemplate 的
 * `{{name}}` 才是渲染占位符（Q12）。两者绝不混用。
 */
import {
  PARAM_PLACEHOLDER_RE, PLACEHOLDER_ONLY_RE, ERROR_SAFE_MESSAGES, HTTP_METHODS,
  MAX_COMPOSITE_STEPS, MAX_JSONPATH_LENGTH, MAX_JSONPATH_SEGMENTS,
} from "./api-command-types.js";
import { normalizeHostname, sanitizeRequestHeaders } from "./api-command-normalize.js";
import type {
  ApiCommand, ApiErrorCode, ApiParam, ExecuteResult, HttpMethod, ParamType, CommandStep, Risk,
} from "./api-command-types.js";

/** 可预期的渲染 / 参数错误，携带统一错误码，编排层据此返回结构化错误。 */
export class RenderError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message || ERROR_SAFE_MESSAGES[code]);
    this.name = "RenderError";
    this.code = code;
  }
}

export interface ValidationResult {
  missingParams: string[];
  invalidParams: string[];
}

export interface RenderedRequest {
  url: string;
  method: HttpMethod;
  body?: string;
  /** 【放开·绿区】已过滤的请求头（凭据头已被剔除）。 */
  headers?: Record<string, string>;
}

function asRecord(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}

function typeMatches(type: ParamType, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    default: return false;
  }
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** 删除 URL query 中「占位符对应参数未提供」的整个 `key={{key}}` 片段。 */
function stripEmptyQuerySegments(url: string, missing: Set<string>): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0 || missing.size === 0) return url;
  const base = url.slice(0, queryIndex);
  const parts = url.slice(queryIndex + 1).split("&").filter((part) => {
    for (const name of missing) {
      if (part.includes(`{{${name}}}`)) return false;
    }
    return true;
  });
  return parts.length > 0 ? `${base}?${parts.join("&")}` : base;
}

/**
 * 校验调用方提供的参数：
 *  - 必填缺失 → missingParams[]（除非该参数有安全 defaultValue 可兜底）；
 *  - 类型不符 / 未知参数 / 值级 allowedValues 不符 → invalidParams[]。
 * allowedValues 只对人工经 update_api_command 显式写入且安全的字面量生效；
 * 自动分析产出根本没有该字段（主理人拍板 2）。
 */
export function validateParams(
  command: ApiCommand,
  params: Record<string, unknown>,
): ValidationResult {
  const missingParams: string[] = [];
  const invalidParams: string[] = [];
  const provided = asRecord(params);
  const known = new Set(command.params.map((param) => param.name));

  for (const key of Object.keys(provided)) {
    if (!known.has(key)) invalidParams.push(key);
  }
  for (const param of command.params) {
    const has = Object.prototype.hasOwnProperty.call(provided, param.name);
    const value = provided[param.name];
    if (!has || value === undefined || value === null) {
      const hasDefault = param.constant === true && param.defaultValue !== undefined;
      if (param.required && !hasDefault) missingParams.push(param.name);
      continue;
    }
    if (!typeMatches(param.type, value)) { invalidParams.push(param.name); continue; }
    if (Array.isArray(param.allowedValues) && param.allowedValues.length > 0
      && !param.allowedValues.some((allowed) => allowed === value)) {
      invalidParams.push(param.name);
    }
  }
  return { missingParams, invalidParams };
}

/** 把命令精简成写命令确认闸门的脱敏 preview（只含模板与参数名，绝不含值）。 */
export function previewFor(command: ApiCommand): NonNullable<ExecuteResult["preview"]> {
  return {
    method: command.request.method,
    urlTemplate: command.request.urlTemplate,
    paramNames: command.params.map((param) => param.name),
    risk: command.risk,
  };
}

/** 解析每个参数的最终取值：优先调用方提供值，其次安全 defaultValue。 */
function resolveValues(command: ApiCommand, params: Record<string, unknown>): Map<string, unknown> {
  const provided = asRecord(params);
  const resolved = new Map<string, unknown>();
  for (const param of command.params) {
    const has = Object.prototype.hasOwnProperty.call(provided, param.name);
    const value = provided[param.name];
    if (has && value !== undefined && value !== null) resolved.set(param.name, value);
    else if (param.constant === true && param.defaultValue !== undefined) resolved.set(param.name, param.defaultValue);
  }
  return resolved;
}

/**
 * 渲染最终请求。
 *  - path 参数值含 `/ ? #`（原始或 URL 解码后）→ UNSAFE_PATH_PARAM（AC-08）；
 *  - 未提供的可选 query 参数整段删除，避免 `{{param}}` 残留进 URL；
 *  - query / path 值统一 encodeURIComponent，body 值保持 number/boolean 类型；
 *  - 渲染后协议与 hostname 二次复核 → INVALID_URL / HOST_MISMATCH_AFTER_RENDER（Q13）。
 *  - 【放开·绿区】请求头：命令自带模板 + 调用方传入合并，凭据头静默剔除。
 */
export function renderRequest(
  command: ApiCommand,
  params: Record<string, unknown>,
  extraHeaders?: Record<string, unknown>,
): RenderedRequest {
  const resolved = resolveValues(command, params);
  if (!(HTTP_METHODS as readonly string[]).includes(command.request.method)) {
    throw new RenderError("INVALID_PARAMS", "命令 method 不在 HTTP 方法枚举内");
  }

  // path 注入防护：值不得含路径分隔符 / query / fragment 标记。
  for (const param of command.params) {
    if (param.location !== "path") continue;
    const value = resolved.get(param.name);
    if (value === undefined) throw new RenderError("MISSING_PARAMS", `缺少必填路径参数 ${param.name}`);
    const text = String(value);
    if (/[/?#]/.test(text) || /[/?#]/.test(safeDecode(text))) {
      throw new RenderError("UNSAFE_PATH_PARAM", `路径参数 ${param.name} 含非法字符`);
    }
  }

  const missing = new Set<string>(
    command.params.filter((param) => !resolved.has(param.name)).map((param) => param.name),
  );
  let url = stripEmptyQuerySegments(command.request.urlTemplate, missing);
  url = url.replace(PARAM_PLACEHOLDER_RE, (_match: string, name: string) => {
    const value = resolved.get(name);
    if (value === undefined) throw new RenderError("MISSING_PARAMS", `缺少必填参数 ${name}`);
    return encodeURIComponent(String(value));
  });

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RenderError("INVALID_URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new RenderError("INVALID_URL");
  const expectedHost = normalizeHostname(command.domain);
  if (!expectedHost || parsed.hostname.toLowerCase() !== expectedHost) {
    throw new RenderError("HOST_MISMATCH_AFTER_RENDER");
  }

  let body: string | undefined;
  const template = command.request.bodyTemplate;
  if (template && typeof template === "object" && !Array.isArray(template)) {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(template)) {
      if (typeof raw === "string" && PLACEHOLDER_ONLY_RE.test(raw)) {
        const name = raw.slice(2, -2);
        const value = resolved.get(name);
        if (value === undefined) continue; // 可选参数未提供 → 不写入该 body 字段
        out[key] = value;                  // 保类型，绝不无谓字符串化
      } else {
        out[key] = raw;                    // 仅安全字面量（缓存加载侧已校验）
      }
    }
    if (Object.keys(out).length > 0) body = JSON.stringify(out);
  }

  // 【放开·绿区】请求头合并：
  //  1) 命令自带模板（值可以是 {{param}} 占位符，也可以是字面量）；
  //  2) 调用方传入的 headers 覆盖同名模板项；
  //  3) 凭据黑名单（cookie / authorization / proxy-authorization / set-cookie）静默剔除。
  const headerTemplate = command.request.headers;
  const merged: Record<string, unknown> = {};
  if (headerTemplate && typeof headerTemplate === "object" && !Array.isArray(headerTemplate)) {
    for (const [key, raw] of Object.entries(headerTemplate as Record<string, unknown>)) {
      if (typeof raw === "string" && PLACEHOLDER_ONLY_RE.test(raw)) {
        const name = raw.slice(2, -2);
        const value = resolved.get(name);
        if (value === undefined) continue;
        merged[key] = value;
      } else {
        merged[key] = raw;
      }
    }
  }
  if (extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders)) {
    for (const [key, value] of Object.entries(extraHeaders)) merged[key] = value;
  }
  const headers = sanitizeRequestHeaders(merged);

  return {
    url,
    method: command.request.method as HttpMethod,
    ...(body !== undefined ? { body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

// ===========================================================================
// 复合命令（多步编排）：JSONPath 取值 + 显式映射表
//
// 语法（2026-11-05 主理人拍板）：
//   取值路径 = JSONPath 子集：$ 根 + .name / ["name"] + [n] / [*]
//   依赖声明 = 显式映射表：{"orderId": {"from": "$.data.order.id"}}
//
// 刻意**不支持**过滤表达式（?()）、脚本（()）、递归下降（..）——
// 它们会把取值路径变成可执行表达式，等于给命令集开后门。
// ===========================================================================

/** JSONPath 子集的一段。 */
export type JsonPathSegment =
  | { kind: "property"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

export interface JsonPathParse {
  ok: boolean;
  segments: JsonPathSegment[];
  /** 失败原因（仅用于诊断，绝不含响应值）。 */
  reason?: string;
}

/** 允许出现在 `.name` 里的字符：字母 / 数字 / 下划线 / 连字符。 */
const JSONPATH_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 解析 JSONPath 子集。
 *
 * 语法：`$` 根，随后任意个 `.name` / `["name"]` / `[n]` / `[*]`。
 * 任何过滤 / 脚本 / 递归 / 切片写法一律拒绝（fail-closed）。
 */
export function parseJsonPath(path: string): JsonPathParse {
  const fail = (reason: string): JsonPathParse => ({ ok: false, segments: [], reason });
  if (typeof path !== "string" || path.length === 0) return fail("取值路径为空");
  if (path.length > MAX_JSONPATH_LENGTH) return fail("取值路径超长");
  if (path[0] !== "$") return fail("取值路径必须以 $ 开头");

  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      // `.name`；`..` 递归下降与 `.*` 通配都拒绝。
      if (path[i + 1] === ".") return fail("不支持递归下降 ..");
      if (path[i + 1] === "*") return fail("不支持通配属性 .*");
      let j = i + 1;
      while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
      const name = path.slice(i + 1, j);
      if (!name || !JSONPATH_NAME_RE.test(name)) return fail("属性名非法");
      segments.push({ kind: "property", name });
      i = j;
      continue;
    }
    if (ch === "[") {
      const end = path.indexOf("]", i + 1);
      if (end < 0) return fail("取值路径缺少 ]");
      const inner = path.slice(i + 1, end).trim();
      if (inner === "*") {
        segments.push({ kind: "wildcard" });
      } else if (/^\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number(inner) });
      } else if (
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
        || (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
      ) {
        const name = inner.slice(1, -1);
        if (!name) return fail("属性名非法");
        segments.push({ kind: "property", name });
      } else {
        // 过滤表达式 (?...)、切片 (..)、脚本 (...) 一律拒绝。
        return fail("只支持 [n] 与 [*]");
      }
      i = end + 1;
      continue;
    }
    return fail("取值路径含非法字符");
  }
  if (segments.length > MAX_JSONPATH_SEGMENTS) return fail("取值路径段数超限");
  return { ok: true, segments };
}

/**
 * 按 JSONPath 子集取值。
 *
 * 返回 `found=false` 表示路径不存在（调用方据此报 MISSING_PARAMS）；
 * `[*]` 一律展开为数组（命中 0 个时 found=false，命中 1 个也仍是数组）。
 */
export function evalJsonPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const parsed = parseJsonPath(path);
  if (!parsed.ok) return { found: false };
  return evalSegments(root, parsed.segments);
}

/** 从指定段开始继续求值。 */
function evalSegments(root: unknown, segments: JsonPathSegment[]): { found: boolean; value?: unknown } {
  if (segments.length === 0) return { found: true, value: root };
  const [head, ...tail] = segments;
  if (head.kind === "property") {
    if (root === null || typeof root !== "object" || Array.isArray(root)) return { found: false };
    const record = root as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, head.name)) return { found: false };
    return evalSegments(record[head.name], tail);
  }
  if (head.kind === "index") {
    if (!Array.isArray(root) || head.index >= root.length) return { found: false };
    return evalSegments(root[head.index], tail);
  }
  // wildcard：展开数组元素，结果恒为数组（JSONPath 语义）。
  if (!Array.isArray(root)) return { found: false };
  const collected: unknown[] = [];
  for (const item of root) {
    const nested = evalSegments(item, tail);
    if (nested.found) collected.push(nested.value);
  }
  if (collected.length === 0) return { found: false };
  return { found: true, value: collected };
}

/** 一条取值映射：`{"from": "<jsonpath>"}`。 */
export interface StepValueMapping {
  from: string;
}

/** 判断一个 step param 值是否为取值映射（`{"from": "<jsonpath>"}`）。 */
export function isStepValueMapping(value: unknown): value is StepValueMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "from") return false;
  return typeof record.from === "string";
}

export interface CompositeStepPlan {
  /** 步骤下标（0 起）。 */
  index: number;
  /** 子命令名（<verb>.<resource>）或 commandId，二选一。 */
  name?: string;
  commandId?: string;
  /** 该步的固定入参（不含取值映射）。 */
  literalParams: Record<string, unknown>;
  /** 该步的取值映射：参数名 → JSONPath。 */
  mappings: Array<{ param: string; path: string }>;
  /** 该步风险覆盖（缺省按子命令自身 risk 判定）。 */
  risk?: Risk;
  /** 审计备注（不含值）。 */
  note?: string;
}

/**
 * 解析复合命令的步骤结构：把每步的 `params` 拆成「固定值」与「取值映射」两类。
 *
 * - 固定值直接透传给子命令；
 * - 取值映射 `{"from": "<jsonpath>"}` 的值在**运行时**从上一步响应里取；
 *   本函数只负责校验路径语法并登记，不做任何 IO。
 */
export function resolveCompositeSteps(command: ApiCommand): CompositeStepPlan[] {
  const rawSteps = Array.isArray(command.steps) ? command.steps : [];
  // 防御超长编排：只处理前 MAX_COMPOSITE_STEPS 步（缓存层已按同样上限拒收非法条目）。
  const steps = rawSteps.slice(0, MAX_COMPOSITE_STEPS);
  return steps.map((step, index) => {
    const literalParams: Record<string, unknown> = {};
    const mappings: Array<{ param: string; path: string }> = [];
    const raw = step && typeof step.params === "object" && !Array.isArray(step.params)
      ? step.params as Record<string, unknown>
      : {};
    for (const [key, value] of Object.entries(raw)) {
      if (isStepValueMapping(value)) {
        mappings.push({ param: key, path: value.from });
        continue;
      }
      literalParams[key] = value;
    }
    return {
      index,
      ...(typeof step?.name === "string" && step.name ? { name: step.name } : {}),
      ...(typeof step?.commandId === "string" && step.commandId ? { commandId: step.commandId } : {}),
      literalParams,
      mappings,
      ...(step?.risk ? { risk: step.risk } : {}),
      ...(typeof step?.note === "string" && step.note ? { note: step.note } : {}),
    };
  });
}

/**
 * 把上一步响应里的取值注入下一步参数。
 *
 * 取值优先级（最具体 → 最泛化）：
 *  1. **取值映射**：步骤作者显式声明的运行时依赖，最具体 —— 路径命中即以此为准；
 *  2. **调用方传值**（baseParams）：覆盖步骤字面量（与 defaultValue 语义一致：调用方传值优先）；
 *  3. **步骤字面量**：最泛化，等同于该步的默认值。
 *
 * - 路径未命中且调用方也给了该参数 → 用调用方的值（记入 **fallback**，**不静默**）；
 * - 路径未命中且调用方没给 → 记入 missing（调用方据此报 MISSING_PARAMS，**不发任何请求**）。
 *
 * 两个信号必须分开：
 *  - `overridden`：取值**命中**，映射的值覆盖了调用方传值 → 调用方传值**未生效**；
 *  - `fallback`：取值**未命中**，退化用调用方传值 → 调用方传值**生效了**，是映射没取到值。
 *
 * 两者方向相反，若共用同一个数组，上层只能给出与事实相反的告警
 * （把「调用方传值生效了」说成「调用方传值未生效」），排查时会被误导。
 */
export function applyStepMappings(
  plan: CompositeStepPlan,
  previousResponse: unknown,
  baseParams: Record<string, unknown>,
): {
  params: Record<string, unknown>;
  missing: string[];
  /** 取值命中、覆盖了调用方传值的参数名。 */
  overridden: string[];
  /** 取值未命中、退化使用调用方传值的参数名。 */
  fallback: string[];
} {
  const params: Record<string, unknown> = { ...plan.literalParams };
  const missing: string[] = [];
  const overridden: string[] = [];
  const fallback: string[] = [];
  // 来自取值映射的参数：调用方传值不得覆盖（流程的连线是权威的）。
  const fromMapping = new Set<string>();

  for (const mapping of plan.mappings) {
    const result = evalJsonPath(previousResponse, mapping.path);
    const callerProvided = Object.prototype.hasOwnProperty.call(baseParams, mapping.param);
    if (result.found) {
      params[mapping.param] = result.value;
      fromMapping.add(mapping.param);
      // 调用方也传了同名参数：映射优先，但必须留痕（不静默忽略）。
      if (callerProvided) overridden.push(mapping.param);
      continue;
    }
    if (callerProvided) {
      // 取值路径未命中 → 退化用调用方传值，并留痕（是 fallback，不是 overridden）。
      params[mapping.param] = baseParams[mapping.param];
      fromMapping.add(mapping.param);
      fallback.push(mapping.param);
      continue;
    }
    missing.push(mapping.param);
  }

  // 调用方传值覆盖步骤字面量（映射槽位除外）。
  for (const [key, value] of Object.entries(baseParams)) {
    if (fromMapping.has(key)) continue;
    params[key] = value;
  }
  return { params, missing, overridden, fallback };
}
