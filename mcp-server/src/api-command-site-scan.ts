/**
 * WebPilot SiteScan —— 静态接口推导（无 IO 纯函数层）。
 *
 * 目标：把「一次页面加载 → 人点过的几条接口」升级为「读前端产物 / 规格 / 归档流量
 * → 整站接口骨架」。与 Q8 抓包采样是**两条完全隔离的通道**：
 *
 *  - Q8：扩展侧 CDP `Network.getResponseBody`，只采 xhr/fetch + JSON/text + 2xx，
 *    前 20 条 / 单条 64KB，样本只在内存，用于推导响应 schema。
 *  - SiteScan：MCP Server（Node 进程）直接读取 JS bundle / HAR / OpenAPI /
 *    声明式命令包，独立配额（40 源 / 单源 2MB / 总计 16MB），不经过浏览器、
 *    不 attach debugger、不依赖 tab 与登录会话，**不新增任何扩展消息**。
 *
 * 硬约束（与现有纯函数层一致）：
 *  1. 本文件不得 import node:fs / fetch / process.env / Date / 任何运行时单例；
 *     远端源的读取与 URL 安全校验的「调用」发生在编排层 api-command-service.ts，
 *     本文件只提供纯函数 `checkScanUrl()` 与 `scanSources()`。
 *  2. 输出只含「字段名 + 路径结构 + HTTP method」，绝不含样本值、header 值、
 *     凭据或业务枚举真实值（AC-04 / AC-10 / AC-20 / Q14）。
 *  3. 结构用单花括号 `{id}`，渲染用双花括号 `{{name}}`，两者不可混用。
 *  4. 静态推导没有真实响应证据，产物一律强制 needsReview + 空 responseSchema，
 *     并由编排层默认按 `risk:"write"` 保守处理（可用 trustSpec 放开规格类来源）。
 */
import {
  SITE_SCAN_MAX_SOURCES,
  SITE_SCAN_MAX_TEXT_CHARS,
  SITE_SCAN_MAX_ENDPOINTS,
  SITE_SCAN_CROSS_HOST_WARNING,
  SITE_SCAN_PRIVATE_HOST_WARNING,
  SITE_SCAN_SOURCE_FAILED_WARNING,
  TELEMETRY_PATH_KEYWORDS,
  HTTP_METHODS,
} from "./api-command-types.js";
import type {
  SiteScanKind, SiteScanCandidate, SiteScanResult,
  NormalizedRecord, HttpMethod,
} from "./api-command-types.js";
import {
  normalizeHostname, isSensitiveFieldName, sanitizeParamName, templatePath,
} from "./api-command-normalize.js";

// ===========================================================================
// 1. URL 安全（SSRF 防护）—— 纯函数，由编排层在 fetch 之前调用
// ===========================================================================

/** 内网 / 回环 / 链路本地 / 常见内网后缀。无法解析的 host 一律按不可信处理。 */
const PRIVATE_HOST_RE = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|[^\s.]+\.(?:local|internal|localhost|lan))$/i;

export function isPrivateHost(host: string): boolean {
  // IPv6 字面量必须在 normalizeHostname() 之前判断：后者会把 "::1" 当端口切掉。
  const raw = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (raw === "::1" || raw === "0:0:0:0:0:0:0:1" || raw.startsWith("::ffff:127.")) return true;
  const normalized = normalizeHostname(host);
  if (!normalized) return true;
  return PRIVATE_HOST_RE.test(normalized);
}

export interface ScanUrlPolicy {
  domain: string;
  /** 【黄区】允许内网 / 回环地址；默认 false。 */
  allowPrivateHosts?: boolean;
  /** 【黄区】允许跨 hostname 的脚本源（CDN）；默认 false，需同时列 extraHosts。 */
  allowCrossHost?: boolean;
  extraHosts?: string[];
}

export interface ScanUrlVerdict {
  ok: boolean;
  host: string;
  url?: string;
  reason?: string;
}

/**
 * 校验一个远端数据源 URL 是否可读。禁止：非 http(s) 协议、URL 内嵌凭据、
 * 跨 hostname（除非显式放开）、私网地址（除非显式放开）。
 * 返回 reason 为固定安全文案，绝不回显原始 URL 或查询串。
 */
export function checkScanUrl(rawUrl: string, policy: ScanUrlPolicy): ScanUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, host: "", reason: SITE_SCAN_SOURCE_FAILED_WARNING };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, host: "", reason: SITE_SCAN_SOURCE_FAILED_WARNING };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, host: "", reason: SITE_SCAN_SOURCE_FAILED_WARNING };
  }
  const host = normalizeHostname(parsed.hostname);
  if (!host) return { ok: false, host: "", reason: SITE_SCAN_SOURCE_FAILED_WARNING };

  // 私网判定必须先于跨 host：否则 127.0.0.1 会被「跨 host」短路，
  // 既拿不到准确的固定文案，也会让黄区开关的语义变得不可预测。
  if (isPrivateHost(host) && policy.allowPrivateHosts !== true) {
    return { ok: false, host, reason: SITE_SCAN_PRIVATE_HOST_WARNING };
  }
  const target = normalizeHostname(policy.domain);
  if (host !== target) {
    const listed = Array.isArray(policy.extraHosts)
      && policy.extraHosts.some((item) => normalizeHostname(String(item)) === host);
    if (policy.allowCrossHost !== true || !listed) {
      return { ok: false, host, reason: SITE_SCAN_CROSS_HOST_WARNING };
    }
  }
  return { ok: true, host, url: parsed.toString() };
}

// ===========================================================================
// 2. 通用工具：路径清洗、参数名、去重
// ===========================================================================

/** 明显不是 API 的静态资源后缀。 */
const STATIC_SUFFIX_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp3|mp4|webm|pdf|zip|html?|txt|json|xml)(?:$|[?#])/i;
/** API 路径前缀提示；loose=false 时只接受这些高置信前缀。 */
const API_PATH_HINT_RE = /^\/(?:api|rest|rpc|graphql|v\d+(?:\.\d+)?|service|services|internal|ajax|data|query|gateway|web|app|open|interface|interface_v\d+|cgi|mtop|zuul|bff)(?:\/|$)/i;
/** 常见业务动作词，用于放宽判定。 */
const ACTION_SEGMENT_RE = /\/(?:list|detail|info|search|query|create|add|update|edit|delete|remove|save|submit|page|pages|export|import|upload|download|batch|count|tree|options|config|status|submit)\b/i;
/** 埋点 / 监控按「路径段」精确匹配：避免 /log 误杀 /login。 */
const TELEMETRY_SEGMENTS = new Set(
  TELEMETRY_PATH_KEYWORDS.map((keyword) => String(keyword).replace(/^\//, "").toLowerCase()),
);
/** OpenAPI / 声明式路径里的 `{name}` 结构标记。 */
const OPENAPI_PARAM_RE = /(?<!\$)\{[A-Za-z_][A-Za-z0-9_]*\}/g;
/** 模板字符串里的 `${...}` 表达式（全局版用于替换，非全局版用于无状态 test）。 */
const TEMPLATE_EXPR_RE = /\$\{[^}]*\}/g;
const TEMPLATE_EXPR_TEST_RE = /\$\{[^}]*\}/;
/** 字符串字面量（单/双引号/反引号），内容以 / 开头。 */
const STRING_LITERAL_RE = /(['"`])(\/[^'"`\s]{2,300})\1/g;
/** 对象键名，用于从 `axios.post(url, { page, size })` 抽 body 参数名。 */
const OBJECT_KEY_RE = /([A-Za-z_$][A-Za-z0-9_$]{0,63})\s*:/g;
/** 明确不像字段名的 JS 关键字 / 配置键。 */
const NON_PARAM_KEYS = new Set([
  "method", "headers", "url", "baseurl", "body", "data", "params", "config",
  "timeout", "credentials", "mode", "cache", "signal", "responsetype",
  "withcredentials", "content", "type", "key", "value", "default", "true", "false", "null",
]);

function safeParamName(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const name = sanitizeParamName(String(raw));
  if (!name || !/^[a-z0-9_]{1,64}$/.test(name)) return undefined;
  if (isSensitiveFieldName(name) || NON_PARAM_KEYS.has(name)) return undefined;
  return name;
}

/** 抽 query 参数名，丢弃取值（Q14：绝不记录真实值）。 */
function queryNamesFrom(rawQuery: string): string[] {
  const out: string[] = [];
  for (const pair of String(rawQuery || "").replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const name = safeParamName(pair.split("=")[0]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 从调用点附近的源码窗口抽 body 字段名，丢弃取值。 */
function bodyNamesFrom(windowText: string): string[] {
  const out: string[] = [];
  OBJECT_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OBJECT_KEY_RE.exec(windowText)) !== null) {
    const name = safeParamName(match[1]);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * 依据调用点上下文推断 HTTP method；无法确定时保守取 GET。
 * before 取「紧邻字面量之前」的源码并取**最后一个** `.verb(`（避免被上一条语句污染），
 * after 优先看 `fetch(url, { method:'POST' })` 这类显式声明。
 */
function inferMethod(before: string, after: string): HttpMethod {
  const explicit = /method\s*[:=]\s*['"`](get|post|put|patch|delete|head|options)['"`]/i.exec(after);
  if (explicit) {
    const verb = explicit[1].toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(verb)) return verb as HttpMethod;
  }
  const callRe = /\.\s*(get|post|put|patch|delete|head)\s*\(/gi;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(before)) !== null) last = match[1];
  if (last) {
    const verb = last.toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(verb)) return verb as HttpMethod;
  }
  return "GET";
}

/** 归一后的模板是否可用于生成命令：必须有静态锚点，且不残留任何模板语法。 */
function isUsablePathTemplate(template: string): boolean {
  if (typeof template !== "string" || !template.startsWith("/")) return false;
  // 残留 `$`（`${...}` 未剥净）、未闭合花括号、反引号都说明归一失败。
  if (/[$`]/.test(template)) return false;
  if (/\{[^}]*$|^[^{]*\}/.test(template)) return false;
  // 全是动态段（如 /{id}）没有任何静态锚点，无法定位业务资源，几乎必为误报。
  const segments = template.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return segments.some((segment) => !/^\{[^}]+\}$/.test(segment));
}

/** 把路径归一为结构模板；动态段必须能被 templatePath / generator 识别。 */
function toPathTemplate(rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string") return undefined;
  const withoutQuery = String(rawPath || "").split(/[?#]/)[0];
  if (!withoutQuery.startsWith("/") || withoutQuery.length > 512) return undefined;
  if (STATIC_SUFFIX_RE.test(withoutQuery)) return undefined;
  const segments = withoutQuery.toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => TELEMETRY_SEGMENTS.has(segment))) return undefined;

  // OpenAPI / 声明式路径已含 {name}：直接转成管线约定的 {id} / {id_2}，
  // 不能交给 templatePath()——它会把花括号清洗成 "_id_"。
  // 正则带 `(?<!\$)`：JS 模板插值 `${id}` 里的 `{id}` 不算 OpenAPI 参数，
  // 否则 `$` 会留在模板里（曾产出 `/${id}` → 填充后 `/$123456789`）。
  OPENAPI_PARAM_RE.lastIndex = 0;
  if (OPENAPI_PARAM_RE.test(withoutQuery)) {
    let dynamicIndex = 0;
    const template = withoutQuery.replace(OPENAPI_PARAM_RE, () => {
      dynamicIndex += 1;
      return dynamicIndex === 1 ? "{id}" : `{id_${dynamicIndex}}`;
    });
    return isUsablePathTemplate(template) ? template : undefined;
  }
  // `${...}` / `:id` / `<id>` 统一换成数字段，让 templatePath 归一成 {id}。
  const concrete = withoutQuery
    .replace(TEMPLATE_EXPR_RE, "123456789")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "123456789")
    .replace(/<[A-Za-z_][A-Za-z0-9_]*>/g, "123456789");
  const templated = templatePath(concrete);
  if (!templated || !templated.pathTemplate) return undefined;
  return isUsablePathTemplate(templated.pathTemplate) ? templated.pathTemplate : undefined;
}

function isApiPath(rawPath: string, loose: boolean): boolean {
  const path = String(rawPath || "").split(/[?#]/)[0];
  if (API_PATH_HINT_RE.test(path)) return true;
  if (TEMPLATE_EXPR_TEST_RE.test(rawPath)) return true;
  if (loose && (ACTION_SEGMENT_RE.test(path) || path.split("/").filter(Boolean).length >= 3)) return true;
  return false;
}

function candidateKey(method: HttpMethod, pathTemplate: string): string {
  return `${method}\u0000${pathTemplate}`;
}

// ===========================================================================
// 3. 四类数据源解析（全部纯函数，只吃 text）
// ===========================================================================

export interface ScanParseOptions {
  /** 放宽路径判定：接受非标准前缀的多段路径（会增加误报，默认 false）。 */
  loose?: boolean;
  /** 单源最多产出的候选数。 */
  maxCandidates?: number;
}

/** 从 JS/TS bundle 文本抽 fetch / axios / 字符串常量里的 API 路径。 */
export function scanJsText(text: string, opts: ScanParseOptions = {}): SiteScanCandidate[] {
  const source = String(text || "").slice(0, SITE_SCAN_MAX_TEXT_CHARS);
  const limit = Number.isFinite(opts.maxCandidates) && Number(opts.maxCandidates) > 0
    ? Math.floor(Number(opts.maxCandidates))
    : SITE_SCAN_MAX_ENDPOINTS;
  const found = new Map<string, SiteScanCandidate>();
  STRING_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRING_LITERAL_RE.exec(source)) !== null) {
    const rawPath = match[2];
    if (!isApiPath(rawPath, opts.loose === true)) continue;
    const pathTemplate = toPathTemplate(rawPath);
    if (!pathTemplate) continue;
    const queryPart = rawPath.includes("?") ? rawPath.slice(rawPath.indexOf("?")) : "";
    const literalEnd = match.index + match[0].length;
    const before = source.slice(Math.max(0, match.index - 100), match.index);
    const after = source.slice(literalEnd, Math.min(source.length, literalEnd + 180));
    const method = inferMethod(before, after);
    const candidate: SiteScanCandidate = {
      method,
      pathTemplate,
      queryNames: queryNamesFrom(queryPart),
      bodyNames: method === "GET" || method === "HEAD" ? [] : bodyNamesFrom(after),
      origin: "js",
    };
    const key = candidateKey(method, pathTemplate);
    if (!found.has(key)) found.set(key, candidate);
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/** 从 HAR 1.2 的 log.entries[].request 抽 method / path / query / postData 字段名。 */
export function parseHarText(text: string, opts: ScanParseOptions = {}): SiteScanCandidate[] {
  const limit = Number.isFinite(opts.maxCandidates) && Number(opts.maxCandidates) > 0
    ? Math.floor(Number(opts.maxCandidates))
    : SITE_SCAN_MAX_ENDPOINTS;
  let data: unknown;
  try { data = JSON.parse(String(text || "")); } catch { return []; }
  const log = (data as Record<string, unknown> | null)?.log as Record<string, unknown> | undefined;
  const entries = Array.isArray(log?.entries) ? log?.entries as unknown[] : [];
  const found = new Map<string, SiteScanCandidate>();
  for (const raw of entries) {
    const entry = raw as Record<string, unknown> | null;
    const request = entry?.request as Record<string, unknown> | undefined;
    if (!request || typeof request.url !== "string") continue;
    let parsed: URL;
    try { parsed = new URL(request.url); } catch { continue; }
    const pathTemplate = toPathTemplate(parsed.pathname);
    if (!pathTemplate) continue;
    // HAR 是真实流量归档，不再用路径前缀提示过滤（站点可能用 /courses/list 这类路径）。
    const methodRaw = String(request.method || "GET").toUpperCase();
    const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodRaw)
      ? methodRaw as HttpMethod : "GET";
    const queryNames = [...parsed.searchParams.keys()].map(safeParamName).filter((n): n is string => !!n);
    const postData = request.postData as Record<string, unknown> | undefined;
    const bodyNames: string[] = [];
    if (Array.isArray(postData?.params)) {
      for (const param of postData.params as unknown[]) {
        const name = safeParamName((param as Record<string, unknown> | null)?.name);
        if (name && !bodyNames.includes(name)) bodyNames.push(name);
      }
    }
    const candidate: SiteScanCandidate = {
      method, pathTemplate,
      queryNames: [...new Set(queryNames)],
      bodyNames: method === "GET" || method === "HEAD" ? [] : bodyNames,
      origin: "har",
    };
    const key = candidateKey(method, pathTemplate);
    if (!found.has(key)) found.set(key, candidate);
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/** 从 OpenAPI 3.x / Swagger 2 的 paths 抽端点与参数名（规格是权威来源）。 */
/**
 * OpenAPI 的路径前缀：Swagger 2.0 的 `basePath`，或 OpenAPI 3 的 `servers[0].url` 的 pathname。
 *
 * 规格里的 `paths` 是**相对 servers 的**路径，漏掉前缀会让生成的所有命令打到错误地址
 * （petstore 的 `/pet/findByStatus` 实际在 `/api/v3/pet/findByStatus`，漏了必然 404）。
 * 含 `{var}` 的 servers 无法静态定值，直接放弃拼前缀而不是猜一个。
 */
function openApiBasePrefix(data: Record<string, unknown> | null): string {
  if (!data) return "";
  const normalize = (raw: unknown): string => {
    if (typeof raw !== "string" || !raw.trim()) return "";
    const value = raw.trim();
    if (value.includes("{")) return "";
    let pathname = "";
    if (value.startsWith("/")) {
      pathname = value.split(/[?#]/)[0];
    } else {
      try { pathname = new URL(value).pathname; } catch { return ""; }
    }
    const clean = pathname.replace(/\/+$/, "");
    if (!clean || clean === "/") return "";
    return clean.startsWith("/") ? clean : `/${clean}`;
  };
  const swagger = normalize(data.basePath);
  if (swagger) return swagger;
  const servers = Array.isArray(data.servers) ? data.servers : [];
  for (const item of servers) {
    const prefix = normalize((item as Record<string, unknown> | null)?.url);
    if (prefix) return prefix;
  }
  return "";
}

export function parseOpenApiText(text: string, opts: ScanParseOptions = {}): SiteScanCandidate[] {
  const limit = Number.isFinite(opts.maxCandidates) && Number(opts.maxCandidates) > 0
    ? Math.floor(Number(opts.maxCandidates))
    : SITE_SCAN_MAX_ENDPOINTS;
  let data: unknown;
  try { data = JSON.parse(String(text || "")); } catch { return []; }
  const paths = (data as Record<string, unknown> | null)?.paths;
  if (!paths || typeof paths !== "object") return [];
  const basePrefix = openApiBasePrefix(
    data && typeof data === "object" ? data as Record<string, unknown> : null,
  );
  const found = new Map<string, SiteScanCandidate>();
  for (const [rawPath, rawItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!rawItem || typeof rawItem !== "object") continue;
    // paths 相对 servers：补 basePath 前缀；已含前缀（部分工具会重复写）则不重复拼。
    const prefixed = basePrefix && rawPath !== basePrefix && !rawPath.startsWith(`${basePrefix}/`)
      ? `${basePrefix}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`
      : rawPath;
    // OpenAPI 的 {id} 已是结构标记，templatePath 会原样保留。
    const pathTemplate = toPathTemplate(prefixed);
    if (!pathTemplate) continue;
    for (const [verb, rawOp] of Object.entries(rawItem as Record<string, unknown>)) {
      const method = verb.toUpperCase();
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const op = (rawOp && typeof rawOp === "object" ? rawOp : {}) as Record<string, unknown>;
      const queryNames: string[] = [];
      const bodyNames: string[] = [];
      if (Array.isArray(op.parameters)) {
        for (const rawParam of op.parameters as unknown[]) {
          const param = (rawParam && typeof rawParam === "object" ? rawParam : {}) as Record<string, unknown>;
          const name = safeParamName(param.name);
          if (!name) continue;
          // path 参数由 pathTemplate 的 {id} 自动推断，不重复写进 query/body。
          if (param.in === "query" && !queryNames.includes(name)) queryNames.push(name);
          if (param.in === "body" && !bodyNames.includes(name)) bodyNames.push(name);
        }
      }
      const content = ((op.requestBody as Record<string, unknown> | undefined)?.content
        ?? {}) as Record<string, unknown>;
      for (const media of Object.values(content)) {
        const schema = (media as Record<string, unknown> | null)?.schema as Record<string, unknown> | undefined;
        const props = schema?.properties;
        if (props && typeof props === "object") {
          for (const key of Object.keys(props as Record<string, unknown>)) {
            const name = safeParamName(key);
            if (name && !bodyNames.includes(name)) bodyNames.push(name);
          }
        }
      }
      const candidate: SiteScanCandidate = {
        method: method as HttpMethod,
        pathTemplate,
        queryNames,
        bodyNames,
        origin: "openapi",
      };
      const key = candidateKey(method as HttpMethod, pathTemplate);
      if (!found.has(key)) found.set(key, candidate);
      if (found.size >= limit) break;
    }
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/** 从本地声明式命令包抽端点（可审查 JSON，只进不出、不随包分发）。 */
export function parseCommandSetText(text: string, opts: ScanParseOptions = {}): SiteScanCandidate[] {
  const limit = Number.isFinite(opts.maxCandidates) && Number(opts.maxCandidates) > 0
    ? Math.floor(Number(opts.maxCandidates))
    : SITE_SCAN_MAX_ENDPOINTS;
  let data: unknown;
  try { data = JSON.parse(String(text || "")); } catch { return []; }
  const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const commands = Array.isArray(root.commands) ? root.commands as unknown[] : [];
  const found = new Map<string, SiteScanCandidate>();
  for (const raw of commands) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const pathTemplate = toPathTemplate(item.path ?? item.pathTemplate);
    if (!pathTemplate) continue;
    const methodRaw = String(item.method || "GET").toUpperCase();
    const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodRaw)
      ? methodRaw as HttpMethod : "GET";
    const queryNames: string[] = [];
    const bodyNames: string[] = [];
    if (Array.isArray(item.params)) {
      for (const rawParam of item.params as unknown[]) {
        const param = (rawParam && typeof rawParam === "object" ? rawParam : {}) as Record<string, unknown>;
        const name = safeParamName(param.name);
        if (!name) continue;
        if (param.location === "body") { if (!bodyNames.includes(name)) bodyNames.push(name); }
        else if (param.location === "query" && !queryNames.includes(name)) queryNames.push(name);
      }
    }
    const candidate: SiteScanCandidate = { method, pathTemplate, queryNames, bodyNames, origin: "commands" };
    const key = candidateKey(method, pathTemplate);
    if (!found.has(key)) found.set(key, candidate);
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

// ===========================================================================
// 4. 统一入口与管线适配
// ===========================================================================

export interface ScanSourcesOptions extends ScanParseOptions {
  domain: string;
  maxEndpoints?: number;
}

/**
 * 统一扫描入口（纯函数）。`sources` 里的 text 已由编排层从 url 读取并校验完毕；
 * 本函数不做任何 IO。返回 candidates / 计数 / 固定安全 warnings。
 */
export function scanSources(
  sources: Array<{ kind: SiteScanKind; text?: string }>,
  opts: ScanSourcesOptions,
): SiteScanResult {
  const warnings: string[] = [];
  const list = Array.isArray(sources) ? sources.slice(0, SITE_SCAN_MAX_SOURCES) : [];
  const perSource = Math.max(1, Math.floor(
    Number.isFinite(opts.maxEndpoints) && Number(opts.maxEndpoints) > 0
      ? Number(opts.maxEndpoints)
      : SITE_SCAN_MAX_ENDPOINTS,
  ));
  const merged = new Map<string, SiteScanCandidate>();
  let sourcesRead = 0;
  let bytesRead = 0;

  for (const source of list) {
    const text = typeof source.text === "string"
      ? source.text.slice(0, SITE_SCAN_MAX_TEXT_CHARS) : "";
    if (!text) { warnings.push(SITE_SCAN_SOURCE_FAILED_WARNING); continue; }
    bytesRead += text.length;
    sourcesRead += 1;
    let candidates: SiteScanCandidate[] = [];
    switch (source.kind) {
      case "js": candidates = scanJsText(text, { loose: opts.loose, maxCandidates: perSource }); break;
      case "har": candidates = parseHarText(text, { loose: opts.loose, maxCandidates: perSource }); break;
      case "openapi": candidates = parseOpenApiText(text, { loose: opts.loose, maxCandidates: perSource }); break;
      case "commands": candidates = parseCommandSetText(text, { loose: opts.loose, maxCandidates: perSource }); break;
      default: break;
    }
    for (const candidate of candidates) {
      const key = candidateKey(candidate.method, candidate.pathTemplate);
      if (!merged.has(key)) merged.set(key, candidate);
      if (merged.size >= perSource) break;
    }
    if (merged.size >= perSource) break;
  }
  return {
    candidates: [...merged.values()],
    sourcesRead,
    bytesRead,
    warnings: [...new Set(warnings)],
  };
}

/**
 * 把静态候选转成管线可消费的 NormalizedRecord[]。
 *
 * 每个候选生成 2 条「变体记录」且参数值不同 —— 这样现有 inferParams() 会把字段
 * 识别为「取值变化 → 参数」而非恒定常量，避免把伪值写成 defaultValue 落盘。
 * 动态段 `{id}` 用不同纯数字填充，交由 groupEndpoints()/templatePath() 归一回结构。
 */
export function toScanRecords(candidates: SiteScanCandidate[], domain: string): NormalizedRecord[] {
  const host = normalizeHostname(domain);
  const out: NormalizedRecord[] = [];
  const list = Array.isArray(candidates) ? candidates : [];
  list.forEach((candidate, index) => {
    if (!candidate || !host) return;
    for (const variant of [0, 1]) {
      const concretePath = candidate.pathTemplate.replace(
        /\{(?:id|id_\d+)\}/g,
        variant === 0 ? "123456789" : "987654321",
      );
      const queryPairs = candidate.queryNames.map((name) => ({
        name, value: variant === 0 ? "1" : "2",
      }));
      const bodyFields = candidate.bodyNames.map((name) => ({
        name,
        value: variant === 0 ? "a" : "b",
        type: "string" as const,
      }));
      out.push({
        requestId: `scan_${index}_${variant}`,
        host,
        method: candidate.method,
        path: concretePath,
        pathSegments: concretePath.split("/").filter(Boolean),
        queryPairs,
        bodyFields,
        bodyIsJson: bodyFields.length > 0,
        status: 200,
        mimeType: "application/json",
        resourceType: "fetch",
        timestamp: index * 2 + variant,
        headerNames: [],
      });
    }
  });
  return out;
}

/** 供编排层判断：该候选是否来自「权威规格」（trustSpec 时可不强制 write）。 */
export function isSpecOrigin(kind: SiteScanKind): boolean {
  return kind === "openapi" || kind === "commands";
}
