/**
 * WebPilot API 命令集 —— 抓包归一化与参数推断（**无 IO 纯函数管线**）。
 *
 * 硬约束：本文件不 import node:fs、不读环境变量、不读 Date.now()、
 * 不依赖任何 MCP server 运行时单例。所有导出函数可被 `node --test` 直接单测。
 *
 * 关键纪律：
 *  1. 真实 HTTP method 只来自 CDP Network.requestWillBeSent；XHR / fetch 伪值一律剔除，
 *     绝不把 page-tools.js 的 performance resource 嗅探结果当作解析数据源。
 *  2. header 只保留**字段名**，绝不保留值。
 *  3. 枚举只记字段名与 enumCount，**绝不记真实值 / 业务样本值**（Q14）。
 *  4. 单花括号 {id} 只用于结构标识与稳定哈希；双花括号 {{name}} 只用于渲染（Q12）。
 */
import {
  HTTP_METHODS, PARAM_NAME_PATTERN, PARAM_RESERVED_NAMES, RESPONSE_SENSITIVE_FIELDS,
  MAX_ENDPOINTS_DEFAULT, MAX_SAFE_LITERAL_LENGTH, MAX_SAFE_INTEGER_ABS,
  MAX_PERSISTED_VALUE_LENGTH, MAX_HEADER_NAME_LENGTH, MAX_ERROR_MESSAGE_LENGTH, REDACTED_VALUE,
  SAFE_LITERAL_STRING_RE, JWT_RE, EMAIL_RE, PHONE_RE,
  UUID_PATTERN, NUMERIC_SEGMENT_RE, HEX_ID_RE, HIGH_ENTROPY_SEGMENT_RE,
  HOSTNAME_PATTERN, API_SENSITIVE_HEADER_RE, HEADER_NAME_PATTERN,
  API_COMMAND_FORBIDDEN_HEADERS, MAX_HEADER_VALUE_LENGTH,
  STATIC_RESOURCE_TYPES, STATIC_ASSET_EXTENSIONS, TELEMETRY_PATH_KEYWORDS,
  NEEDS_REVIEW_DESCRIPTION_PREFIX,
} from "./api-command-types.js";
import type {
  RawCapturedRecord, NormalizedRecord, EndpointGroup, ApiParam, HttpMethod,
  ParamType, FilterCandidatesOptions, FilterResult, PathTemplateResult, ParsedBodyFields,
} from "./api-command-types.js";

// ---------------------------------------------------------------------------
// hostname 工具（缓存管理器与编排层共用，纯函数）
// ---------------------------------------------------------------------------

/**
 * 归一化精确 hostname：小写、去协议 / userinfo / 端口 / 路径 / query / hash / 尾部点。
 * Q13：不合并 www.、不向父域回退。与 isUrlAllowed 的子域匹配语义刻意区分。
 */
export function normalizeHostname(input: string): string {
  if (typeof input !== "string") return "";
  let value = input.trim().toLowerCase();
  if (!value) return "";
  const schemeIndex = value.indexOf("://");
  if (schemeIndex >= 0) value = value.slice(schemeIndex + 3);
  for (const delimiter of ["/", "?", "#"]) {
    const index = value.indexOf(delimiter);
    if (index >= 0) value = value.slice(0, index);
  }
  const atIndex = value.lastIndexOf("@");
  if (atIndex >= 0) value = value.slice(atIndex + 1);
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close >= 0) value = value.slice(0, close + 1);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(value.slice(colon + 1))) value = value.slice(0, colon);
  }
  return value.replace(/\.+$/, "");
}

/** hostname 合法性：无协议 / 路径 / 端口 / 通配符 / 空白 / 连续点。 */
export function isValidHostname(host: string): boolean {
  if (typeof host !== "string") return false;
  const value = host.trim().toLowerCase();
  if (!value || value.length > 253) return false;
  if (value.includes("..") || /[\s/*?#:@]/.test(value)) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (value.startsWith("[") && value.endsWith("]")) return true; // IPv6 字面量
  return HOSTNAME_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 安全字面量 / 凭据 / 敏感字段名（生成器与缓存白名单重建共用）
// ---------------------------------------------------------------------------

/** 字段名是否命中响应敏感字段黑名单（password / token / csrf / ...）。 */
export function isSensitiveFieldName(name: string): boolean {
  if (typeof name !== "string" || !name) return false;
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!lower) return false;
  for (const bad of RESPONSE_SENSITIVE_FIELDS) {
    const key = bad.replace(/[^a-z0-9]/g, "");
    if (key && (lower === key || lower.includes(key))) return true;
  }
  return false;
}

/** 参数名是否为工具级保留字或敏感字段名。 */
export function isForbiddenParamName(name: string): boolean {
  if (typeof name !== "string" || !name) return true;
  const lower = name.toLowerCase();
  if ((PARAM_RESERVED_NAMES as readonly string[]).includes(lower)) return true;
  return isSensitiveFieldName(lower);
}

/**
 * 疑似凭据 / 业务样本值检测：JWT 三段式、邮箱、手机号、Bearer/Basic、
 * Cookie/Authorization 片段、URL 中的 token 类参数、≥24 位高熵串、32+ hex。
 * 只做形态判断，绝不返回值本身。
 */
export function looksLikeCredential(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (JWT_RE.test(text)) return true;
  if (EMAIL_RE.test(text)) return true;
  if (PHONE_RE.test(text)) return true;
  if (/(?:bearer|basic)\s+[a-z0-9._-]+/i.test(text)) return true;
  if (/^(?:cookie|set-cookie|authorization)\s*:/i.test(text)) return true;
  if (/[?&](?:token|key|secret|sig|signature|access_token|auth|password)=/i.test(text)) return true;
  if (/^[0-9a-f]{32,}$/i.test(text)) return true;
  const plain = text.replace(/[^a-z0-9]/gi, "");
  if (plain.length >= 24 && /[0-9]/.test(plain) && /[a-z]/i.test(plain)) return true;
  return false;
}

/**
 * 安全字面量判定（主理人拍板 3）：布尔、小整数、≤32 字符纯小写字母/数字/短连词。
 * 明确拒绝 JWT / 邮箱 / 手机 / 长随机串 / 敏感字段名字符串。
 * 只允许落 defaultValue / allowedValues，绝不允许落业务样本值。
 */
export function isSafeLiteral(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) <= MAX_SAFE_INTEGER_ABS;
  }
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_SAFE_LITERAL_LENGTH) return false;
  if (looksLikeCredential(value)) return false;
  if (isSensitiveFieldName(value)) return false;
  return SAFE_LITERAL_STRING_RE.test(value);
}

/** 字段名 + 值双重判定：常量 defaultValue 落盘前必须通过。 */
export function isSafeLiteralForField(fieldName: string, value: unknown): boolean {
  if (isForbiddenParamName(fieldName)) return false;
  return isSafeLiteral(value);
}

/**
 * 【放开·绿区】真凭据形态判定：JWT / Bearer / Basic / Cookie / Authorization / token 类 query。
 *
 * 与 looksLikeCredential 的刻意差别：本判定**不**把邮箱、手机号、长随机串当成凭据 ——
 * 它们是业务样本值，本次放开就是要让它们落盘。真凭据则永远不落盘，
 * 否则导出的命令包会把可直接使用的令牌交给别人。
 */
export function looksLikeAuthCredential(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (JWT_RE.test(text)) return true;
  if (/(?:bearer|basic)\s+[a-z0-9._-]+/i.test(text)) return true;
  if (/^(?:cookie|set-cookie|authorization)\s*:/i.test(text)) return true;
  if (/[?&](?:token|access_token|auth|password|secret|sig|signature)=/i.test(text)) return true;
  return false;
}

/**
 * 【放开·绿区】可落盘的标量值判定：布尔 / 有限数 / 长度 ≤ MAX_PERSISTED_VALUE_LENGTH 的字符串。
 *
 * 放开前用 isSafeLiteral（≤32 字符纯小写字母数字 + 排除疑似凭据形态），
 * 结果是真实业务值（昵称 / 订单号 / 一次性口令）**一律无法落盘**，
 * 恒定字段只能退化成「必填参数」，命令调用方还得自己重新提供每个值。
 * 现在允许标量样本值落盘（长度有上限），值本身仍不进入日志 / 报告 / warnings。
 *
 * **真凭据形态仍然拒绝落盘**（JWT / Bearer / Cookie / token 类 query）——
 * 「放开业务样本值」不等于「把可用令牌写进可交付的文件」。
 *
 * isSafeLiteral 保留为严格模式开关（人工标注 allowedValues 等仍可用它）。
 */
export function isPersistableLiteral(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PERSISTED_VALUE_LENGTH) return false;
  if (looksLikeAuthCredential(value)) return false;
  return true;
}

/** 字段名 + 值双重判定：常量 defaultValue 落盘前必须通过（放开版）。 */
export function isPersistableLiteralForField(fieldName: string, value: unknown): boolean {
  if (isForbiddenParamName(fieldName)) return false;
  return isPersistableLiteral(value);
}

/**
 * 错误消息脱敏：去掉 URL query / key=value / Bearer / JWT / Cookie / 邮箱 / 手机号 /
 * 长串，超长截断。用于 health.lastError、errors[]、console 日志，绝不让样本值泄漏。
 * 返回值不含任何原值；若仍疑似凭据则返回空串，调用方改用 ERROR_SAFE_MESSAGES 兜底。
 */
export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== "string" || !message.trim()) return "";
  let text = message.trim();
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    const queryIndex = match.search(/[?#]/);
    return queryIndex >= 0 ? `${match.slice(0, queryIndex)} ${REDACTED_VALUE}` : match;
  });
  text = text.replace(/([?&;\s][a-z0-9_-]{1,32})=([^\s&;,)]+)/gi, `$1=${REDACTED_VALUE}`);
  text = text.replace(/(?:bearer|basic)\s+[a-z0-9._-]+/gi, REDACTED_VALUE);
  text = text.replace(/\b[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED_VALUE);
  text = text.replace(/(?:cookie|set-cookie|authorization)\s*:\s*[^\s;,]+/gi, REDACTED_VALUE);
  text = text.replace(EMAIL_RE, REDACTED_VALUE);
  text = text.replace(/\b\+?\d[\d\s()-]{6,20}\b/g, REDACTED_VALUE);
  text = text.replace(/\b[a-z0-9]{24,}\b/gi, REDACTED_VALUE);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_ERROR_MESSAGE_LENGTH) text = text.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  if (looksLikeCredential(text)) return "";
  return text;
}

/** 从 header 字段名清单中挑出**敏感字段名**（供报告 redactedHeaders[]）。只返回名字，无值。 */
export function redactHeaderNames(names: string[]): string[] {
  const out = new Set<string>();
  if (!Array.isArray(names)) return [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase().slice(0, MAX_HEADER_NAME_LENGTH);
    if (!name) continue;
    if (API_SENSITIVE_HEADER_RE.test(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * 【放开·绿区】请求头过滤：保留**全部非凭据头**，只剔除凭据黑名单。
 *
 * 放开前只允许 `accept` / `content-type` 两个头，站点一旦校验
 * `X-Requested-With` / `Referer` / `Origin` 就一律 403。
 * 现在：凭据头（cookie / authorization / proxy-authorization / set-cookie）
 * 静默剔除；字段名非法、值含 CR/LF（header 注入）或超长的头一律丢弃。
 */
export function sanitizeRequestHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return out;
  for (const [rawName, rawValue] of Object.entries(headers as Record<string, unknown>)) {
    const name = String(rawName).trim();
    if (!name || !HEADER_NAME_PATTERN.test(name)) continue;
    if ((API_COMMAND_FORBIDDEN_HEADERS as readonly string[]).includes(name.toLowerCase())) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") continue;
    const value = String(rawValue);
    if (!value || value.length > MAX_HEADER_VALUE_LENGTH) continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 值类型与参数名工具
// ---------------------------------------------------------------------------

/** typeof → ParamType 映射（null 统一按 string 处理）。 */
export function inferValueType(value: unknown): ParamType {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

/** 把任意字段名规范化为 PARAM_NAME_PATTERN 合法名；无法规范化返回空串。 */
export function sanitizeParamName(raw: string): string {
  if (typeof raw !== "string") return "";
  const name = raw.trim().toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return PARAM_NAME_PATTERN.test(name) ? name : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeURIComponentSafe(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

// ---------------------------------------------------------------------------
// 请求体解析
// ---------------------------------------------------------------------------

function flattenBodyFields(obj: Record<string, unknown>, prefix = "", depth = 0): ParsedBodyFields["fields"] {
  const out: ParsedBodyFields["fields"] = [];
  if (depth > 2) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (!key) continue;
    const name = prefix ? `${prefix}_${key}` : key;
    if (isPlainObject(value) && depth < 2) {
      out.push(...flattenBodyFields(value, name, depth + 1));
    } else {
      out.push({ name, value, type: inferValueType(value) });
    }
  }
  return out;
}

/**
 * 解析原始请求体：优先 JSON（含数组首元素），其次 x-www-form-urlencoded。
 * 返回的 value 仅驻留内存用于「取值是否变化」判定，绝不进入命令定义 / 缓存 / 报告。
 */
export function parseBodyFields(postData: string | null | undefined): ParsedBodyFields {
  if (typeof postData !== "string" || !postData.trim()) return { fields: [], isJson: false };
  const text = postData.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const obj: Record<string, unknown> = Array.isArray(parsed)
        ? (parsed.length > 0 && isPlainObject(parsed[0]) ? parsed[0] : {})
        : (isPlainObject(parsed) ? parsed : {});
      return { fields: flattenBodyFields(obj), isJson: true };
    } catch {
      // JSON 解析失败时落到 urlencoded 分支。
    }
  }
  if (!/\s/.test(text) && text.includes("=")) {
    const fields: ParsedBodyFields["fields"] = [];
    try {
      for (const [name, value] of new URLSearchParams(text).entries()) {
        if (name) fields.push({ name, value, type: "string" });
      }
    } catch {
      return { fields: [], isJson: false };
    }
    if (fields.length > 0) return { fields, isJson: false };
  }
  return { fields: [], isJson: false };
}

// ---------------------------------------------------------------------------
// 阶段 1→2：CDP 记录归一化
// ---------------------------------------------------------------------------

/**
 * RawCapturedRecord[] → NormalizedRecord[]。
 * - method 取 CDP 真实 HTTP method 并大写；XHR / fetch 等伪值直接剔除（不在 HTTP_METHODS）。
 * - host 精确等于目标 hostname（Q13），第三方域名记录剔除。
 * - header 只保留字段名清单，绝不保留值。
 */
export function normalizeRecords(raw: RawCapturedRecord[], domain: string): NormalizedRecord[] {
  const target = normalizeHostname(domain);
  const out: NormalizedRecord[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const method = String(item.method ?? "").trim().toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
    let url: URL;
    try { url = new URL(String(item.url ?? "")); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if (target && host !== target) continue;
    const path = url.pathname || "/";
    const pathSegments = path.split("/").filter((segment) => segment.length > 0);
    const queryPairs: Array<{ name: string; value: string }> = [];
    for (const [name, value] of url.searchParams.entries()) {
      if (name) queryPairs.push({ name, value });
    }
    const parsedBody = parseBodyFields(item.postData ?? undefined);
    const headerNames = Array.isArray(item.headerNames)
      ? [...new Set(
          item.headerNames
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean),
        )].sort()
      : [];
    out.push({
      requestId: typeof item.requestId === "string" ? item.requestId : "",
      host,
      method: method as HttpMethod,
      path,
      pathSegments,
      queryPairs,
      bodyFields: parsedBody.fields,
      bodyIsJson: parsedBody.isJson,
      status: Number.isFinite(item.status) ? Number(item.status) : 0,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "",
      resourceType: typeof item.resourceType === "string" ? item.resourceType : undefined,
      timestamp: Number.isFinite(item.timestamp) ? Number(item.timestamp) : 0,
      headerNames,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 阶段 4：路径模板化（单花括号 {id}）
// ---------------------------------------------------------------------------

/** 判定某路径段是否为动态 ID（数字 / UUID / 长随机串 / 常见 ID 形态）。 */
export function isDynamicPathSegment(segment: string): boolean {
  if (typeof segment !== "string" || !segment) return false;
  const value = decodeURIComponentSafe(segment);
  if (NUMERIC_SEGMENT_RE.test(value)) return true;
  if (UUID_PATTERN.test(value)) return true;
  if (HEX_ID_RE.test(value)) return true;
  if (HIGH_ENTROPY_SEGMENT_RE.test(value)) return true;
  // 常见业务 ID 形态：短字母前缀 + 至少 2 位数字（C-001 / ORD123 / P-001）。
  // 刻意不把 `v1` / `api-v1` 这类版本段误判为动态 ID。
  if (/^[a-z]{1,8}[-_]?\d{2,}$/i.test(value)) return true;
  if (/^[a-z0-9_-]{16,}$/i.test(value) && /\d/.test(value) && /[a-z]/i.test(value)) {
    const digitCount = (value.match(/\d/g) || []).length;
    if (digitCount >= Math.max(3, Math.floor(value.length / 3))) return true;
  }
  const withoutExt = value.replace(/\.(?:json|html|do|action|php|aspx)$/i, "");
  if (withoutExt !== value && withoutExt) return isDynamicPathSegment(withoutExt);
  return false;
}

function sanitizePathSegment(segment: string): string {
  const clean = segment.replace(/[{}"'\\<>]/g, "_").replace(/\s+/g, "_");
  return clean.slice(0, 128) || "_";
}

/**
 * path → { pathTemplate, pathParams }。
 * 动态段统一为 `{id}`；同一路径多个动态段从第二个起为 `{id_2}` / `{id_3}`，
 * 保证参数名唯一且符合 PARAM_NAME_PATTERN。query 动态值不进路径模板，转参数位。
 */
export function templatePath(path: string): PathTemplateResult {
  if (typeof path !== "string" || !path) return { pathTemplate: "/", pathParams: [] };
  const clean = (path.split("?")[0].split("#")[0]) || "/";
  const segments = clean.split("/").filter((segment) => segment.length > 0);
  const pathParams: string[] = [];
  const outSegments: string[] = [];
  let dynamicIndex = 0;
  for (const segment of segments) {
    if (isDynamicPathSegment(segment)) {
      dynamicIndex += 1;
      const paramName = dynamicIndex === 1 ? "id" : `id_${dynamicIndex}`;
      outSegments.push(`{${paramName}}`);
      pathParams.push(paramName);
    } else {
      outSegments.push(sanitizePathSegment(segment));
    }
  }
  const pathTemplate = outSegments.length > 0 ? `/${outSegments.join("/")}` : "/";
  return { pathTemplate, pathParams };
}

/** 分组 / schema Map 的统一键：method + \u0000 + pathTemplate。 */
export function endpointKey(method: HttpMethod, pathTemplate: string): string {
  return `${method}\u0000${pathTemplate}`;
}

// ---------------------------------------------------------------------------
// 阶段 3：候选过滤
// ---------------------------------------------------------------------------

/**
 * 排除静态资源（受 includeStaticAssets 控制）、埋点 / 监控、第三方域名；
 * 再按 method + pathTemplate 的观测次数排序，保留前 maxEndpoints 个端点。
 * warnings 只含计数与固定文案，绝不含 URL / 参数值 / header 值。
 */
export function filterCandidates(records: NormalizedRecord[], opts: FilterCandidatesOptions): FilterResult {
  const warnings: string[] = [];
  const source = Array.isArray(records) ? records : [];
  const includeStatic = opts?.includeStaticAssets === true;
  const requested = Number.isFinite(opts?.maxEndpoints) ? Math.floor(opts.maxEndpoints) : MAX_ENDPOINTS_DEFAULT;
  const limit = requested > 0 ? requested : MAX_ENDPOINTS_DEFAULT;
  const targetHost = source.length > 0 ? normalizeHostname(source[0].host) : "";

  let ignoredStatic = 0;
  let ignoredThirdParty = 0;
  let ignoredTelemetry = 0;
  const candidates: NormalizedRecord[] = [];
  for (const rec of source) {
    if (!rec || typeof rec !== "object") continue;
    const resourceType = String(rec.resourceType ?? "").toLowerCase();
    const lowerPath = String(rec.path ?? "").toLowerCase();
    const isStatic = (STATIC_RESOURCE_TYPES as readonly string[]).includes(resourceType)
      || STATIC_ASSET_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
    if (!includeStatic && isStatic) { ignoredStatic += 1; continue; }
    if (TELEMETRY_PATH_KEYWORDS.some((keyword) => lowerPath.includes(keyword))) { ignoredTelemetry += 1; continue; }
    const host = normalizeHostname(String(rec.host ?? ""));
    if (targetHost && host !== targetHost) { ignoredThirdParty += 1; continue; }
    candidates.push(rec);
  }

  const counts = new Map<string, number>();
  for (const rec of candidates) {
    const { pathTemplate } = templatePath(rec.path);
    const key = endpointKey(rec.method, pathTemplate);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const allowed = new Set(ranked.map(([key]) => key));
  const droppedEndpoints = Math.max(0, counts.size - allowed.size);
  const kept = candidates.filter((rec) => {
    const { pathTemplate } = templatePath(rec.path);
    return allowed.has(endpointKey(rec.method, pathTemplate));
  });

  if (ignoredStatic > 0) warnings.push(`已按 includeStaticAssets=false 忽略 ${ignoredStatic} 个静态资源端点`);
  if (ignoredTelemetry > 0) warnings.push(`已忽略 ${ignoredTelemetry} 个埋点 / 监控类端点`);
  if (ignoredThirdParty > 0) warnings.push(`已按精确 hostname 过滤忽略 ${ignoredThirdParty} 个第三方域名端点`);
  if (droppedEndpoints > 0) warnings.push(`已按 maxEndpoints=${limit} 截断，忽略 ${droppedEndpoints} 个低频端点`);

  return {
    kept,
    ignored: ignoredStatic + ignoredTelemetry + ignoredThirdParty + (candidates.length - kept.length),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 阶段 5：分组聚合
// ---------------------------------------------------------------------------

/**
 * 按 method + host + pathTemplate 聚合多次抓包样本，保持首次出现顺序。
 *
 * 分组键**含 host**：静态推导会把协议相对 URL（//host/path）还原到各自的 host，
 * 同一路径挂在不同 host 上是不同接口，并成一条必然有一半打错地址。
 * 抓包通道里所有记录的 host 相同，因此该键与旧的 method+pathTemplate 分组等价。
 */
export function groupEndpoints(records: NormalizedRecord[]): EndpointGroup[] {
  const groups = new Map<string, EndpointGroup>();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== "object") continue;
    const { pathTemplate, pathParams } = templatePath(rec.path);
    const key = `${rec.host}\u0000${endpointKey(rec.method, pathTemplate)}`;
    let group = groups.get(key);
    if (!group) {
      group = { method: rec.method, pathTemplate, pathParams, records: [], host: rec.host };
      groups.set(key, group);
    }
    group.records.push(rec);
    // 来源种类取并集：同一端点被多个来源观察到时，证据档位由最强来源决定。
    if (Array.isArray(rec.sourceKinds) && rec.sourceKinds.length > 0) {
      const kinds = new Set(group.sourceKinds ?? []);
      for (const kind of rec.sourceKinds) kinds.add(kind);
      group.sourceKinds = [...kinds];
    }
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// 阶段 6：参数推断
// ---------------------------------------------------------------------------

interface FieldObservation {
  rawName: string;
  name: string;
  location: "query" | "body";
  values: unknown[];
  appearances: number;
  totalRecords: number;
}

function majorityType(values: unknown[]): ParamType {
  const tally = new Map<ParamType, number>();
  for (const value of values) {
    if (value === null || value === undefined || typeof value === "object") continue;
    const type = inferValueType(value);
    tally.set(type, (tally.get(type) || 0) + 1);
  }
  let best: ParamType = "string";
  let bestCount = 0;
  for (const [type, count] of tally) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  if (bestCount === 0 && values.some((value) => Array.isArray(value))) return "array";
  if (bestCount === 0 && values.some((value) => isPlainObject(value))) return "object";
  return best;
}

function uniqueParamName(base: string, location: "path" | "query" | "body", used: Set<string>): string {
  if (!used.has(base)) return base;
  const suffix = location === "path" ? "_path" : `_${location}`;
  let candidate = `${base}${suffix}`.slice(0, 64);
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${suffix}${index}`.slice(0, 64);
    index += 1;
  }
  return candidate;
}

/**
 * EndpointGroup → ApiParam[]。
 * - 样本间取值变化 → 参数（required:false，只记 enumCount，**绝不写 allowedValues**）。
 * - 恒定字段 → constant:true + 仅安全字面量 defaultValue（过 isSafeLiteralForField）。
 * - 不安全常量 → 转必填参数并用 description 前缀标记，供 generateCommands 生成 needsReview。
 * - 敏感字段名 / 工具级保留字 → 丢弃该参数位（不落盘字段名）。
 * - path 段的 {id} → 必填 string 参数；{id_2} 等同理，参数名唯一。
 */
export function inferParams(group: EndpointGroup): ApiParam[] {
  const params: ApiParam[] = [];
  const used = new Set<string>();
  if (!group || !Array.isArray(group.records)) return params;
  const totalRecords = group.records.length;

  // 1) path 参数优先占位，保证 urlTemplate 渲染可对应。
  for (const rawName of Array.isArray(group.pathParams) ? group.pathParams : []) {
    const name = sanitizeParamName(rawName);
    if (!name || isForbiddenParamName(name)) continue;
    const finalName = uniqueParamName(name, "path", used);
    used.add(finalName);
    params.push({ name: finalName, location: "path", type: "string", required: true });
  }

  // 2) 收集 query / body 字段观测（value 只在局部 Map 中，绝不写入输出）。
  const observations = new Map<string, FieldObservation>();
  const observe = (rawName: string, value: unknown, location: "query" | "body"): void => {
    const name = sanitizeParamName(rawName);
    if (!name || isForbiddenParamName(name)) return;
    const key = `${location}\u0000${name}`;
    let entry = observations.get(key);
    if (!entry) {
      entry = { rawName, name, location, values: [], appearances: 0, totalRecords };
      observations.set(key, entry);
    }
    entry.values.push(value);
    entry.appearances += 1;
  };
  for (const rec of group.records) {
    for (const pair of rec.queryPairs) observe(pair.name, pair.value, "query");
    for (const field of rec.bodyFields) observe(field.name, field.value, "body");
  }

  // 3) 逐字段生成参数。
  const sorted = [...observations.values()].sort((a, b) => {
    if (a.location !== b.location) return a.location === "query" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const distinct = new Set(entry.values.map((value) => String(value))).size;
    const varies = distinct > 1;
    const alwaysPresent = entry.appearances === totalRecords;
    const finalName = uniqueParamName(entry.name, entry.location, used);
    if (isForbiddenParamName(finalName)) continue;
    used.add(finalName);
    const type = majorityType(entry.values);
    const param: ApiParam = {
      name: finalName,
      location: entry.location,
      type,
      required: false,
    };
    if (varies) {
      // Q14：只记「观测到 N 个取值」，绝不记真实值；绝不写 allowedValues。
      param.enumCount = Math.min(distinct, 1000000);
      param.required = false;
    } else if (alwaysPresent) {
      const onlyValue = entry.values[0];
      if (typeof onlyValue === "string" || typeof onlyValue === "number" || typeof onlyValue === "boolean") {
        // 【放开·绿区】恒定字段的标量值允许落盘（长度有上限），
        // 值同时写进 param.defaultValue；命令模板里用 {{name}} 占位，调用方可覆盖。
        if (isPersistableLiteralForField(finalName, onlyValue)) {
          param.constant = true;
          param.defaultValue = onlyValue;
          param.required = false;
        } else {
          param.required = true;
          param.description = `${NEEDS_REVIEW_DESCRIPTION_PREFIX}原请求恒定字段超出可落盘长度，已转为必填参数，请人工提供`;
        }
      } else {
        param.required = true;
        param.description = `${NEEDS_REVIEW_DESCRIPTION_PREFIX}原请求恒定字段非标量，已转为必填参数，请人工提供`;
      }
    } else {
      // 部分样本出现、取值恒定：视为可选参数，不落盘任何字面值。
      param.required = false;
    }
    params.push(param);
  }

  // 推导完毕即丢弃 observations（其中的样本值随函数返回被回收，绝不外泄）。
  return params;
}
