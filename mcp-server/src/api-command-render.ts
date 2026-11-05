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
} from "./api-command-types.js";
import { normalizeHostname, sanitizeRequestHeaders } from "./api-command-normalize.js";
import type {
  ApiCommand, ApiErrorCode, ApiParam, ExecuteResult, HttpMethod, ParamType,
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
