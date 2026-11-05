/**
 * WebPilot API 命令集 —— 域名级持久化缓存 Repository。
 *
 * 完全对齐 selector-cache.ts 范式：懒加载 ensureLoaded、tmp+rename 原子写、
 * toCommand() 逐条**白名单重建**（不是透传）、单条失败只跳过并记 errors/skippedInvalid、
 * 连续 4 次失败禁用 / 一次成功复活、report() 健康度、写失败只告警不阻断。
 *
 * 增强：损坏 JSON 备份 *.corrupt-<ts> 后重建；schemaVersion 高版本跳过 / 低版本
 * needsMigration；full / merge 合并算法（人工修正保护）；disabled / drifted /
 * authRequired / stale 状态机；WEBPILOT_API_COMMAND_DIR 回退任务日志目录；
 * 单文件 api-commands.json 按精确 hostname 分组（Q13，不合并 www. / 子域）。
 *
 * 安全：加载侧与写入侧都做白名单重建；reason / errors[] / lastError / 日志字符串
 * 一律不含样本值、header 值或字面凭据（AC-17 / AC-20）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SUPPORTED_SCHEMA_VERSION, CACHE_VERSION, CACHE_FILE_NAME,
  GENERATED_BY, EPOCH_ISO, API_LOG_PREFIX, MAX_CONSECUTIVE_FAILURES, STALE_AFTER_DAYS,
  MAX_NOTE_LENGTH, MAX_RESPONSE_FIELDS, MAX_SCHEMA_FIELDS,
  HTTP_METHODS, PARAM_LOCATIONS, PARAM_TYPES, RISKS,
  COMMAND_NAME_PATTERN, PARAM_NAME_PATTERN, COMMAND_ID_PATTERN,
  RESPONSE_FIELD_PATTERN, PATH_TEMPLATE_PATTERN, PLACEHOLDER_ONLY_RE,
  COMMAND_ALLOWED_KEYS, COMMAND_FORBIDDEN_KEYS, REQUEST_TEMPLATE_ALLOWED_KEYS,
  API_PARAM_ALLOWED_KEYS, SCHEMA_FIELD_ALLOWED_KEYS, RESPONSE_SCHEMA_ALLOWED_KEYS,
  PARAM_RESERVED_NAMES, COMMAND_SOURCE_ORIGINS,
  ERROR_SAFE_MESSAGES, STALE_MANUAL_WARNING, NO_CACHE_LIST_WARNING,
} from "./api-command-types.js";
import {
  normalizeHostname, isValidHostname, isSafeLiteral, isSensitiveFieldName,
  isPersistableLiteral, looksLikeCredential, sanitizeErrorMessage, redactHeaderNames,
  sanitizeRequestHeaders,
} from "./api-command-normalize.js";
import type {
  ApiCommand, ApiParam, ApiCommandCacheFile, DomainBucket, CacheLoadDiagnostics,
  CacheReport, CommandCard, CommandSummary, ListResult, AnalysisDiff, AnalysisMode,
  RequestTemplate, ResponseSchema, SchemaField, CommandHealth, Risk, HttpMethod,
  ApiErrorCode, CommandSourceOrigin,
} from "./api-command-types.js";

// ===========================================================================
// 对外补充类型（设计 3.7 的方法签名引用）
// ===========================================================================

export type CommandPatch = Partial<Pick<ApiCommand, "name" | "params" | "responseFields" | "note" | "deprecated">>;
export type ListOptions = { includeDisabled?: boolean; keyword?: string; risk?: Risk };
export type MergeOptions = { mode: AnalysisMode; overwriteManual: boolean };
export type InvalidateOptions = { commandId?: string; action: "disable" | "delete" | "clear_domain" };
export type MergeResult = {
  diff: AnalysisDiff;
  preservedManualEdits: string[];
  stale: string[];
  warnings: string[];
};
export type InvalidateResult = { affected: number; remaining: number };

type Rebuild<T> = { ok: true; value: T } | { ok: false };

const EMPTY_DIFF: AnalysisDiff = { added: 0, updated: 0, removed: 0, skipped: 0, reviewRequired: 0 };

// ===========================================================================
// 默认路径（doctor 与缓存管理器共用，避免重复解析环境变量）
// ===========================================================================

/** WEBPILOT_API_COMMAND_DIR → WEBPILOT_TASK_LOG_DIR → .webpilot-task-logs（Q15）。 */
export function defaultApiCommandCacheFile(): string {
  const dir = process.env.WEBPILOT_API_COMMAND_DIR?.trim()
    || process.env.WEBPILOT_TASK_LOG_DIR?.trim()
    || join(process.cwd(), ".webpilot-task-logs");
  return join(dir, CACHE_FILE_NAME);
}

// ===========================================================================
// 白名单重建内部工具
// ===========================================================================

function fail(
  diag: CacheLoadDiagnostics,
  host: string,
  commandId: string,
  reason: string,
): undefined {
  diag.skippedInvalid.push({ host, ...(commandId ? { commandId } : {}), reason });
  diag.errors.push({ source: `${host}/${commandId || "unknown"}`, error: reason });
  return undefined;
}

function failRebuild(
  diag: CacheLoadDiagnostics,
  host: string,
  commandId: string,
  reason: string,
): { ok: false } {
  fail(diag, host, commandId, reason);
  return { ok: false };
}

function hasForbiddenKeys(raw: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    if ((COMMAND_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) return key;
  }
  return undefined;
}

function finiteInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim().toLowerCase());
  }
  return [...new Set(out)];
}

function lastFieldName(path: string): string {
  const segments = path.split(".");
  return (segments[segments.length - 1] || "").replace(/\[\]$/, "");
}

function rebuildResponseFields(value: unknown): string[] {
  const out: string[] = [];
  for (const item of toStringArray(value)) {
    if (item.length > 256 || !RESPONSE_FIELD_PATTERN.test(item)) continue;
    if (isSensitiveFieldName(lastFieldName(item))) continue; // 敏感字段不纳入白名单
    out.push(item);
    if (out.length >= MAX_RESPONSE_FIELDS) break;
  }
  return out;
}

function rebuildRequestTemplate(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<RequestTemplate> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return failRebuild(diag, host, commandId, "request 不是对象");
  }
  const forbidden = hasForbiddenKeys(raw as Record<string, unknown>, REQUEST_TEMPLATE_ALLOWED_KEYS);
  if (forbidden) return failRebuild(diag, host, commandId, `request 含禁止字段 ${forbidden}，已跳过`);

  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "";
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    return failRebuild(diag, host, commandId, "request.method 不在 HTTP 方法枚举内");
  }
  const pathTemplate = typeof raw.pathTemplate === "string" ? raw.pathTemplate : "";
  if (!pathTemplate.startsWith("/") || !PATH_TEMPLATE_PATTERN.test(pathTemplate)) {
    return failRebuild(diag, host, commandId, "request.pathTemplate 格式非法");
  }
  const urlTemplate = typeof raw.urlTemplate === "string" ? raw.urlTemplate : "";
  let parsed: URL;
  try { parsed = new URL(urlTemplate); } catch {
    return failRebuild(diag, host, commandId, "request.urlTemplate 不是合法绝对 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failRebuild(diag, host, commandId, "request.urlTemplate 协议必须为 http(s)");
  }
  if (parsed.hostname.toLowerCase() !== host) {
    return failRebuild(diag, host, commandId, "request.urlTemplate 的 host 与所属 hostname 不一致（外域 URL）");
  }
  // 外域 / 字面凭据：query 值只允许 {{param}} 占位符或可落盘标量；
  // 字段名命中敏感黑名单（token / password / secret …）时一律拒绝。
  for (const [key, value] of parsed.searchParams.entries()) {
    if (PLACEHOLDER_ONLY_RE.test(value)) continue;
    if (isSensitiveFieldName(key) || !isPersistableLiteral(value)) {
      return failRebuild(diag, host, commandId, "request.urlTemplate query 含敏感字段字面量或超长值");
    }
  }
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    if (/^\{\{[a-z0-9_]{1,64}\}\}$/.test(segment) || /^\{[a-z0-9_]{1,64}\}$/.test(segment)) continue;
    if (segment.length > 128 || looksLikeCredential(segment)) {
      return failRebuild(diag, host, commandId, "request.urlTemplate 路径含疑似凭据或异常长段");
    }
  }

  const bodyRebuild = rebuildBodyTemplate(raw.bodyTemplate, host, commandId, diag);
  if (!bodyRebuild.ok) return bodyRebuild;
  const queryRebuild = rebuildQueryTemplate(raw.queryTemplate, host, commandId, diag);
  if (!queryRebuild.ok) return queryRebuild;
  const headerRebuild = rebuildHeaderTemplate(raw.headers, host, commandId, diag);
  if (!headerRebuild.ok) return headerRebuild;

  return {
    ok: true,
    value: {
      method: method as HttpMethod,
      urlTemplate,
      pathTemplate,
      bodyTemplate: bodyRebuild.value,
      queryTemplate: queryRebuild.value,
      ...(Object.keys(headerRebuild.value).length > 0 ? { headers: headerRebuild.value } : {}),
    },
  };
}

/**
 * 请求头模板重建（放开项）：值只允许 {{param}} 占位符或可落盘标量；
 * 字段名命中凭据黑名单（cookie / authorization / proxy-authorization / set-cookie）时一律拒绝。
 */
function rebuildHeaderTemplate(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<Record<string, string>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return failRebuild(diag, host, commandId, "headers 必须是扁平对象");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      return failRebuild(diag, host, commandId, "headers 值必须是字符串");
    }
    if (!PLACEHOLDER_ONLY_RE.test(value) && !isPersistableLiteral(value)) {
      return failRebuild(diag, host, commandId, "headers 含超长或非标量字面量");
    }
    const filtered = sanitizeRequestHeaders({ [key]: value });
    if (!Object.prototype.hasOwnProperty.call(filtered, key)) {
      return failRebuild(diag, host, commandId, "headers 含凭据头或非法字段名");
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

function rebuildBodyTemplate(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<Record<string, unknown> | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return failRebuild(diag, host, commandId, "bodyTemplate 必须是扁平对象（拒绝异常嵌套）");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PARAM_NAME_PATTERN.test(key)) {
      return failRebuild(diag, host, commandId, "bodyTemplate 键名不符合参数名规范");
    }
    if (typeof value === "string") {
      if (PLACEHOLDER_ONLY_RE.test(value)) { out[key] = value; continue; }
      // 字面量值：字段名命中敏感黑名单（token / password / secret …）时一律拒绝，
      // 否则凭据会被写进可交付的命令包。
      if (isSensitiveFieldName(key) || !isPersistableLiteral(value)) {
        return failRebuild(diag, host, commandId, "bodyTemplate 含敏感字段字面量或超长值");
      }
      out[key] = value; continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      if (isSensitiveFieldName(key) || !isPersistableLiteral(value)) {
        return failRebuild(diag, host, commandId, "bodyTemplate 含敏感字段字面量或超长值");
      }
      out[key] = value; continue;
    }
    if (value === null) { out[key] = null; continue; }
    return failRebuild(diag, host, commandId, "bodyTemplate 不支持嵌套结构或函数字段");
  }
  return { ok: true, value: out };
}

function rebuildQueryTemplate(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<Record<string, string>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return failRebuild(diag, host, commandId, "queryTemplate 必须是扁平对象");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PARAM_NAME_PATTERN.test(key)) {
      return failRebuild(diag, host, commandId, "queryTemplate 键名不符合参数名规范");
    }
    if (typeof value !== "string") {
      return failRebuild(diag, host, commandId, "queryTemplate 值必须是字符串");
    }
    if (PLACEHOLDER_ONLY_RE.test(value)) { out[key] = value; continue; }
    // 字面量值：敏感字段名（token / password / secret …）一律拒绝，其余标量按可落盘判据。
    if (isSensitiveFieldName(key) || !isPersistableLiteral(value)) {
      return failRebuild(diag, host, commandId, "queryTemplate 含敏感字段字面量或超长值");
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

function rebuildParams(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<ApiParam[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return failRebuild(diag, host, commandId, "params 必须是数组");
  const out: ApiParam[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return failRebuild(diag, host, commandId, "params 含非对象条目");
    }
    const forbidden = hasForbiddenKeys(item as Record<string, unknown>, API_PARAM_ALLOWED_KEYS);
    if (forbidden) return failRebuild(diag, host, commandId, `params 含禁止字段 ${forbidden}，已跳过`);

    const name = typeof item.name === "string" ? item.name : "";
    if (!PARAM_NAME_PATTERN.test(name)
      || (PARAM_RESERVED_NAMES as readonly string[]).includes(name.toLowerCase())
      || isSensitiveFieldName(name)) {
      return failRebuild(diag, host, commandId, "参数名非法、为保留字或命中敏感字段名");
    }
    if (!(PARAM_LOCATIONS as readonly string[]).includes(item.location)) {
      return failRebuild(diag, host, commandId, "参数 location 非法");
    }
    if (!(PARAM_TYPES as readonly string[]).includes(item.type)) {
      return failRebuild(diag, host, commandId, "参数 type 非法");
    }
    const param: ApiParam = {
      name,
      location: item.location,
      type: item.type,
      required: item.required === true,
    };
    if (typeof item.description === "string" && item.description.trim()) {
      param.description = item.description.slice(0, MAX_NOTE_LENGTH);
    }
    if (Number.isInteger(item.enumCount) && item.enumCount >= 0) {
      param.enumCount = Math.min(1000000, Number(item.enumCount));
    }
    if (item.constant === true) param.constant = true;
    // 值级 enum 校验只对人工显式写入且每个值都过 isSafeLiteral 的 allowedValues 生效；
    // 自动分析产出根本不写 allowedValues。不安全值 → 跳过整条命令。
    if (Array.isArray(item.allowedValues)) {
      const allowed: Array<string | number | boolean> = [];
      for (const value of item.allowedValues) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          return failRebuild(diag, host, commandId, "allowedValues 含非标量值，已跳过该命令");
        }
        if (!isSafeLiteral(value)) {
          return failRebuild(diag, host, commandId, "allowedValues 含不安全字面量，已跳过该命令");
        }
        allowed.push(value);
      }
      if (allowed.length > 0) param.allowedValues = allowed;
    }
    if (item.defaultValue !== undefined) {
      // 【放开·绿区】标量样本值允许落盘（长度有上限）；超长 / 非标量一律丢弃并转必填参数。
      if (isPersistableLiteral(item.defaultValue)) {
        param.defaultValue = item.defaultValue as string | number | boolean;
      } else {
        // 超出可落盘范围的 defaultValue 绝不落盘：丢弃并转为必填参数，由调用方现场提供。
        param.required = true;
      }
    }
    out.push(param);
  }
  return { ok: true, value: out };
}

function rebuildResponseSchema(
  raw: any, host: string, commandId: string, diag: CacheLoadDiagnostics,
): Rebuild<ResponseSchema> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: { fields: [], depthLimited: false, sampleCount: 0 } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return failRebuild(diag, host, commandId, "responseSchema 必须是对象");
  }
  const forbidden = hasForbiddenKeys(raw as Record<string, unknown>, RESPONSE_SCHEMA_ALLOWED_KEYS);
  if (forbidden) return failRebuild(diag, host, commandId, `responseSchema 含禁止字段 ${forbidden}`);
  const fields: SchemaField[] = [];
  if (Array.isArray(raw.fields)) {
    for (const item of raw.fields.slice(0, MAX_SCHEMA_FIELDS)) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.path !== "string" || !RESPONSE_FIELD_PATTERN.test(item.path)) continue;
      const forbiddenField = hasForbiddenKeys(item as Record<string, unknown>, SCHEMA_FIELD_ALLOWED_KEYS);
      if (forbiddenField) continue;
      const type = typeof item.type === "string"
        && ((PARAM_TYPES as readonly string[]).includes(item.type) || item.type === "null")
        ? item.type
        : "string";
      fields.push({
        path: item.path,
        type,
        array: item.array === true,
        isPagination: item.isPagination === true,
        redacted: item.redacted === true,
      });
    }
  }
  return {
    ok: true,
    value: {
      fields,
      depthLimited: raw.depthLimited === true,
      sampleCount: finiteInt(raw.sampleCount),
    },
  };
}

function rebuildSource(raw: any): ApiCommand["source"] {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const originRaw = typeof source.origin === "string" ? source.origin : "";
  const origin = (COMMAND_SOURCE_ORIGINS as readonly string[]).includes(originRaw)
    ? originRaw as CommandSourceOrigin
    : "capture";
  return {
    analysisId: typeof source.analysisId === "string" ? source.analysisId.slice(0, 128) : "",
    analyzedAt: isoOr(source.analyzedAt, EPOCH_ISO),
    generatedBy: typeof source.generatedBy === "string" ? source.generatedBy.slice(0, 64) : GENERATED_BY,
    origin,
    ...(source.crossHost === true ? { crossHost: true } : {}),
  };
}

function rebuildHealth(raw: any, needsMigration: boolean): CommandHealth {
  const health = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const lastError = typeof health.lastError === "string"
    ? (sanitizeErrorMessage(health.lastError) || ERROR_SAFE_MESSAGES.HTTP_ERROR)
    : undefined;
  return {
    hits: finiteInt(health.hits),
    misses: finiteInt(health.misses),
    consecutiveFailures: finiteInt(health.consecutiveFailures),
    disabled: health.disabled === true,
    totalDurationMs: finiteNumber(health.totalDurationMs),
    lastSuccessAt: isoOrUndefined(health.lastSuccessAt),
    lastFailureAt: isoOrUndefined(health.lastFailureAt),
    ...(lastError ? { lastError } : {}),
    drifted: health.drifted === true,
    authRequired: health.authRequired === true,
    needsMigration: needsMigration || health.needsMigration === true,
    stale: health.stale === true,
  };
}

/** 逐字段**重建**一条命令：未知键一律丢弃，绝不 JSON.parse 后透传（AC-17）。 */
export function toCommand(
  raw: any, host: string, diag: CacheLoadDiagnostics,
): ApiCommand | undefined {
  const commandId = raw && typeof raw === "object" && typeof raw.commandId === "string" ? raw.commandId : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(diag, host, commandId, "缓存条目不是对象");
  }
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    return fail(diag, host, commandId, "commandId 格式非法");
  }
  const forbiddenTop = hasForbiddenKeys(raw as Record<string, unknown>, COMMAND_ALLOWED_KEYS);
  if (forbiddenTop) {
    return fail(diag, host, commandId, `检测到禁止字段 ${forbiddenTop}，已跳过该命令`);
  }
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return fail(diag, host, commandId, "命令名不符合命名规范或含动态值");
  }
  const domain = typeof raw.domain === "string" ? normalizeHostname(raw.domain) : "";
  if (!isValidHostname(host) || domain !== host) {
    return fail(diag, host, commandId, "domain 与所属 hostname 不一致或 hostname 非法");
  }
  if (!(RISKS as readonly string[]).includes(raw.risk)) {
    return fail(diag, host, commandId, "risk 必须为 read 或 write");
  }
  const confidence = finiteNumber(raw.confidence);
  const rawVersion = Number.isInteger(raw.schemaVersion) ? Number(raw.schemaVersion) : 0;
  if (rawVersion > SUPPORTED_SCHEMA_VERSION) {
    return fail(diag, host, commandId,
      `schemaVersion ${rawVersion} 高于支持版本 ${SUPPORTED_SCHEMA_VERSION}，已跳过（不猜测）`);
  }
  const needsMigration = rawVersion < SUPPORTED_SCHEMA_VERSION;
  if (needsMigration) {
    diag.errors.push({
      source: `${host}/${commandId}`,
      error: `schemaVersion ${rawVersion} 低于支持版本，已标记 needsMigration 并进 needsReview，不静默按新结构解释`,
    });
  }
  let note: string | undefined;
  if (typeof raw.note === "string" && raw.note.trim()) {
    const candidate = raw.note.trim();
    if (candidate.length > MAX_NOTE_LENGTH || looksLikeCredential(candidate)) {
      return fail(diag, host, commandId, "note 超长或含疑似凭据，已跳过该命令");
    }
    note = candidate;
  }

  const requestRebuild = rebuildRequestTemplate(raw.request, host, commandId, diag);
  if (!requestRebuild.ok) return undefined;
  const paramsRebuild = rebuildParams(raw.params, host, commandId, diag);
  if (!paramsRebuild.ok) return undefined;
  const schemaRebuild = rebuildResponseSchema(raw.responseSchema, host, commandId, diag);
  if (!schemaRebuild.ok) return undefined;

  return {
    commandId,
    name,
    domain: host,
    risk: raw.risk as Risk,
    confidence: Math.min(1, confidence),
    schemaVersion: rawVersion,
    manuallyEdited: raw.manuallyEdited === true,
    deprecated: raw.deprecated === true,
    ...(note ? { note } : {}),
    request: requestRebuild.value,
    params: paramsRebuild.value,
    responseFields: rebuildResponseFields(raw.responseFields),
    responseSchema: schemaRebuild.value,
    redactedHeaderNames: redactHeaderNames(toStringArray(raw.redactedHeaderNames)),
    source: rebuildSource(raw.source),
    health: rebuildHealth(raw.health, needsMigration),
    analyzedAt: isoOr(raw.analyzedAt, EPOCH_ISO),
    lastVerifiedAt: isoOr(raw.lastVerifiedAt, EPOCH_ISO),
    createdAt: isoOr(raw.createdAt, EPOCH_ISO),
    updatedAt: isoOr(raw.updatedAt, EPOCH_ISO),
  };
}

function toCard(command: ApiCommand): CommandCard {
  return {
    commandId: command.commandId,
    name: command.name,
    method: command.request.method,
    pathTemplate: command.request.pathTemplate,
    risk: command.risk,
    confidence: command.confidence,
    params: command.params,
    paramNames: command.params.map((param) => param.name),
    responseFields: command.responseFields,
    manuallyEdited: command.manuallyEdited,
    disabled: command.health.disabled,
    drifted: command.health.drifted,
    schemaVersion: command.schemaVersion,
    updatedAt: command.updatedAt,
  };
}

// ===========================================================================
// Repository
// ===========================================================================

export class ApiCommandCache {
  private readonly domains = new Map<string, DomainBucket>();
  private readonly file: string;
  private loaded = false;
  private diag: CacheLoadDiagnostics = { skippedInvalid: [], errors: [] };

  constructor(file?: string) {
    this.file = file || defaultApiCommandCacheFile();
  }

  /** 懒加载：首次 list / get / merge / report / summary 才读盘。 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        const detail = sanitizeErrorMessage(String(error?.message ?? "")) || ERROR_SAFE_MESSAGES.WRITE_FAILED;
        this.diag.errors.push({ source: this.file, error: `读取缓存失败：${detail}` });
        console.error(`${API_LOG_PREFIX} could not load cache file: ${detail}`);
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await rename(this.file, backup);
        this.diag.backupFile = backup;
      } catch (renameError: any) {
        const detail = sanitizeErrorMessage(String(renameError?.message ?? "")) || ERROR_SAFE_MESSAGES.WRITE_FAILED;
        console.error(`${API_LOG_PREFIX} could not backup corrupt cache: ${detail}`);
      }
      this.diag.errors.push({ source: this.file, error: "缓存 JSON 解析失败，已备份损坏文件并重建空缓存" });
      console.error(`${API_LOG_PREFIX} corrupt cache backed up, empty cache rebuilt`);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !parsed.domains || typeof parsed.domains !== "object" || Array.isArray(parsed.domains)) {
      this.diag.errors.push({ source: this.file, error: "缓存文件结构非法（缺少 domains 对象），已忽略" });
      return;
    }
    // 顶层 version 高于支持版本只告警，不静默按新结构解释。
    if (Number.isInteger(parsed.version) && Number(parsed.version) > CACHE_VERSION) {
      this.diag.errors.push({
        source: this.file,
        error: `缓存文件 version ${parsed.version} 高于支持版本 ${CACHE_VERSION}，仅按已知字段加载`,
      });
    }

    for (const [rawHost, rawBucket] of Object.entries(parsed.domains)) {
      const host = normalizeHostname(rawHost);
      if (!isValidHostname(host)) {
        this.diag.errors.push({ source: String(rawHost), error: "hostname 非法，已跳过该域名分组" });
        this.diag.skippedInvalid.push({ host: String(rawHost), reason: "hostname 非法（含协议/路径/端口/通配符）" });
        continue;
      }
      const bucket = rawBucket as any;
      if (!bucket || typeof bucket !== "object" || !Array.isArray(bucket.commands)) {
        this.diag.errors.push({ source: host, error: "域名分组结构非法，已跳过" });
        this.diag.skippedInvalid.push({ host, reason: "commands 不是数组" });
        continue;
      }
      const commands: ApiCommand[] = [];
      for (const rawCommand of bucket.commands) {
        const command = toCommand(rawCommand, host, this.diag);
        if (command) commands.push(command);
      }
      this.domains.set(host, {
        host,
        updatedAt: isoOr(bucket.updatedAt, EPOCH_ISO),
        commands,
      });
    }
  }

  /** 原子写：先写 .tmp 再 rename；写失败只告警，绝不阻断调用链路。 */
  private async persist(): Promise<void> {
    const domains: Record<string, DomainBucket> = {};
    for (const [host, bucket] of this.domains) {
      domains[host] = { host, updatedAt: bucket.updatedAt, commands: bucket.commands };
    }
    const payload: ApiCommandCacheFile = {
      version: CACHE_VERSION,
      generatedBy: GENERATED_BY,
      updatedAt: new Date().toISOString(),
      domains,
    };
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, this.file);
    } catch (error: any) {
      const detail = sanitizeErrorMessage(String(error?.message ?? "")) || ERROR_SAFE_MESSAGES.WRITE_FAILED;
      console.error(`${API_LOG_PREFIX} could not persist cache: ${detail}`);
    }
  }

  private bucket(domain: string): DomainBucket | undefined {
    return this.domains.get(normalizeHostname(domain));
  }

  /** 列出某域名可用命令（自动加载入口）；disabled / deprecated 默认视同未命中。 */
  async list(domain: string, opts: ListOptions = {}): Promise<ListResult> {
    await this.ensureLoaded();
    const host = normalizeHostname(domain);
    const warnings: string[] = [];
    for (const entry of this.diag.errors.slice(-5)) warnings.push(`缓存加载告警：${entry.error}`);
    const bucket = this.bucket(host);
    if (!bucket) {
      warnings.push(NO_CACHE_LIST_WARNING);
      return { domain: host, autoLoaded: true, cacheHit: false, total: 0, commands: [], stale: [], warnings };
    }
    const includeDisabled = opts.includeDisabled === true;
    const keyword = typeof opts.keyword === "string" ? opts.keyword.toLowerCase().trim() : "";
    const riskFilter = opts.risk;
    const nowMs = Date.now();
    const stale: string[] = [];
    const cards: CommandCard[] = [];
    for (const command of bucket.commands) {
      const available = !command.health.disabled && !command.deprecated;
      if (!includeDisabled && !available) continue;
      if (keyword && !command.name.toLowerCase().includes(keyword) && !command.commandId.includes(keyword)) continue;
      if (riskFilter && command.risk !== riskFilter) continue;
      const verified = Date.parse(command.lastVerifiedAt);
      const isStale = command.health.stale === true
        || (!Number.isNaN(verified) && nowMs - verified > STALE_AFTER_DAYS * 86400000);
      if (isStale) stale.push(command.commandId);
      cards.push(toCard(command));
    }
    if (stale.length > 0) {
      warnings.push(`存在 ${stale.length} 条陈旧命令（超过 ${STALE_AFTER_DAYS} 天未验证），建议重新分析；陈旧仅提示、不自动失效`);
    }
    return { domain: host, autoLoaded: true, cacheHit: true, total: cards.length, commands: cards, stale, warnings };
  }

  /** 按 commandId / name 查单条完整定义；disabled / deprecated 视同未命中。 */
  async get(domain: string, ref: { commandId?: string; name?: string }): Promise<ApiCommand | undefined> {
    await this.ensureLoaded();
    const bucket = this.bucket(domain);
    if (!bucket) return undefined;
    const id = ref?.commandId;
    const name = ref?.name;
    const command = bucket.commands.find((candidate) =>
      (typeof id === "string" && candidate.commandId === id)
      || (typeof name === "string" && candidate.name === name));
    if (!command) return undefined;
    if (command.health.disabled || command.deprecated) return undefined;
    return command;
  }

  /**
   * full / merge 合并（Q6：默认保留人工修正；主理人拍板 1）。
   *  - 写入前对每条 fresh 再跑一次 toCommand() 白名单重建；
   *  - mode=full 且「未观测到 & manuallyEdited & !overwriteManual」→ 保留 + stale + warnings；
   *  - 非人工条目在 full 下正常 removed；merge 的 removed 恒为 0；
   *  - manuallyEdited 条目只按 name 补新参数位，健康度保留。
   */
  async merge(domain: string, fresh: ApiCommand[], opts: MergeOptions): Promise<MergeResult> {
    await this.ensureLoaded();
    const host = normalizeHostname(domain);
    const warnings: string[] = [];
    if (!isValidHostname(host)) {
      return { diff: { ...EMPTY_DIFF }, preservedManualEdits: [], stale: [], warnings: ["domain 非法，未写入缓存"] };
    }
    const localDiag: CacheLoadDiagnostics = { skippedInvalid: [], errors: [] };
    const clean: ApiCommand[] = [];
    for (const candidate of Array.isArray(fresh) ? fresh : []) {
      const rebuilt = toCommand(candidate as any, host, localDiag);
      if (rebuilt) clean.push(rebuilt);
    }
    for (const skipped of localDiag.skippedInvalid) {
      warnings.push(`生成命令 ${skipped.commandId || ""} 未通过写入侧白名单校验：${skipped.reason}`);
    }

    const mode: AnalysisMode = opts?.mode === "full" ? "full" : "merge";
    const overwriteManual = opts?.overwriteManual === true;
    const now = new Date().toISOString();
    let bucket = this.bucket(host);
    if (!bucket) {
      bucket = { host, updatedAt: now, commands: [] };
      this.domains.set(host, bucket);
    }
    const diff: AnalysisDiff = { ...EMPTY_DIFF };
    const preservedManualEdits: string[] = [];
    const stale: string[] = [];
    const freshById = new Map(clean.map((command) => [command.commandId, command]));
    const handled = new Set<string>();
    const next: ApiCommand[] = [];

    for (const existing of bucket.commands) {
      const incoming = freshById.get(existing.commandId);
      handled.add(existing.commandId);
      if (!incoming) {
        if (mode === "merge" || (existing.manuallyEdited && !overwriteManual)) {
          existing.health.stale = true;
          existing.updatedAt = now;
          next.push(existing);
          stale.push(existing.commandId);
          diff.skipped += 1;
          if (mode === "full" && existing.manuallyEdited && !overwriteManual) warnings.push(STALE_MANUAL_WARNING);
          continue;
        }
        diff.removed += 1;
        continue;
      }
      if (existing.manuallyEdited && !overwriteManual) {
        const known = new Set(existing.params.map((param) => param.name));
        const additions = incoming.params.filter((param) =>
          !known.has(param.name) && !isSensitiveFieldName(param.name));
        existing.params = [...existing.params, ...additions];
        existing.lastVerifiedAt = now;
        existing.updatedAt = now;
        existing.health.stale = false;
        next.push(existing);
        preservedManualEdits.push(`${existing.commandId}: name, params, responseFields, note`);
        diff.skipped += 1;
        continue;
      }

      const structureChanged = existing.request.method !== incoming.request.method
        || existing.request.pathTemplate !== incoming.request.pathTemplate
        || existing.request.urlTemplate !== incoming.request.urlTemplate
        || existing.responseFields.join("|") !== incoming.responseFields.join("|")
        || existing.params.map((param) => param.name).join("|") !== incoming.params.map((param) => param.name).join("|");

      const merged: ApiCommand = {
        ...incoming,
        manuallyEdited: false,
        deprecated: existing.deprecated,   // 人工弃用标记不因一次分析自动复活
        note: existing.note,               // 人工备注不因一次分析被抹掉
        createdAt: existing.createdAt,
        analyzedAt: incoming.source.analyzedAt || incoming.analyzedAt,
        lastVerifiedAt: now,
        updatedAt: now,
        health: { ...existing.health },
      };
      if (mode === "full") {
        // 保留 hits 总量，清零连续失败 / 禁用（对齐设计 1.3.3）。
        merged.health.consecutiveFailures = 0;
        merged.health.disabled = false;
      }
      if (structureChanged) {
        merged.health.drifted = true;
        diff.reviewRequired += 1;
      }
      merged.health.stale = false;
      merged.health.authRequired = false;
      merged.health.needsMigration = false;
      next.push(merged);
      diff.updated += 1;
    }

    for (const incoming of clean) {
      if (handled.has(incoming.commandId)) continue;
      incoming.lastVerifiedAt = now;
      incoming.updatedAt = now;
      incoming.health.stale = false;
      next.push(incoming);
      diff.added += 1;
    }

    bucket.commands = next;
    bucket.updatedAt = now;
    await this.persist();
    return { diff, preservedManualEdits, stale, warnings };
  }

  /** 人工修正：置 manuallyEdited=true；allowedValues 必须逐值过 isSafeLiteral。 */
  async update(domain: string, commandId: string, patch: CommandPatch): Promise<ApiCommand | undefined> {
    await this.ensureLoaded();
    const host = normalizeHostname(domain);
    const bucket = this.bucket(host);
    if (!bucket) return undefined;
    const command = bucket.commands.find((candidate) => candidate.commandId === commandId);
    if (!command) return undefined;
    const localDiag: CacheLoadDiagnostics = { skippedInvalid: [], errors: [] };

    if (typeof patch.name === "string" && COMMAND_NAME_PATTERN.test(patch.name)) command.name = patch.name;
    if (Array.isArray(patch.params)) {
      const rebuilt = rebuildParams(patch.params, host, commandId, localDiag);
      if (rebuilt.ok) command.params = rebuilt.value;
    }
    if (Array.isArray(patch.responseFields)) command.responseFields = rebuildResponseFields(patch.responseFields);
    if (typeof patch.note === "string") {
      const note = patch.note.trim().slice(0, MAX_NOTE_LENGTH);
      if (!looksLikeCredential(note)) command.note = note;
    }
    if (typeof patch.deprecated === "boolean") command.deprecated = patch.deprecated;
    command.manuallyEdited = true;
    command.updatedAt = new Date().toISOString();
    bucket.updatedAt = command.updatedAt;
    await this.persist();
    return command;
  }

  /** disable / delete / clear_domain。 */
  async invalidate(domain: string, opts: InvalidateOptions): Promise<InvalidateResult> {
    await this.ensureLoaded();
    const host = normalizeHostname(domain);
    const bucket = this.bucket(host);
    if (!bucket) return { affected: 0, remaining: 0 };
    const now = new Date().toISOString();
    if (opts.action === "clear_domain") {
      const affected = bucket.commands.length;
      this.domains.delete(host);
      await this.persist();
      return { affected, remaining: 0 };
    }
    if (!opts.commandId) return { affected: 0, remaining: bucket.commands.length };
    let affected = 0;
    if (opts.action === "delete") {
      const before = bucket.commands.length;
      bucket.commands = bucket.commands.filter((command) => command.commandId !== opts.commandId);
      affected = before - bucket.commands.length;
    } else {
      for (const command of bucket.commands) {
        if (command.commandId === opts.commandId && !command.health.disabled) {
          command.health.disabled = true;
          command.updatedAt = now;
          affected = 1;
        }
      }
    }
    if (affected > 0) bucket.updatedAt = now;
    await this.persist();
    return { affected, remaining: bucket.commands.length };
  }

  /** 一次成功：hits+1、清零连续失败、复活 disabled、清 authRequired / stale。 */
  async recordSuccess(domain: string, commandId: string, durationMs: number): Promise<void> {
    await this.ensureLoaded();
    const bucket = this.bucket(domain);
    if (!bucket) return;
    const command = bucket.commands.find((candidate) => candidate.commandId === commandId);
    if (!command) return;
    const now = new Date().toISOString();
    command.health.hits += 1;
    command.health.consecutiveFailures = 0;
    command.health.disabled = false;
    command.health.authRequired = false;
    command.health.stale = false;
    command.health.lastSuccessAt = now;
    command.health.totalDurationMs += Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    command.updatedAt = now;
    bucket.updatedAt = now;
    await this.persist();
  }

  /**
   * 失败计数：连续 MAX_CONSECUTIVE_FAILURES 次自动禁用；
   * AUTH_REQUIRED 只标 flag + 脱敏 lastError，不计入 consecutiveFailures、不禁用、不重试（AC-19）。
   */
  async recordFailure(domain: string, commandId: string, code: ApiErrorCode, message: string): Promise<void> {
    await this.ensureLoaded();
    const bucket = this.bucket(domain);
    if (!bucket) return;
    const command = bucket.commands.find((candidate) => candidate.commandId === commandId);
    if (!command) return;
    const now = new Date().toISOString();
    const safeMessage = sanitizeErrorMessage(message) || ERROR_SAFE_MESSAGES[code] || ERROR_SAFE_MESSAGES.HTTP_ERROR;
    if (code === "AUTH_REQUIRED") {
      command.health.authRequired = true;
      command.health.lastFailureAt = now;
      command.health.lastError = safeMessage;
      command.updatedAt = now;
      bucket.updatedAt = now;
      await this.persist();
      return;
    }
    command.health.misses += 1;
    command.health.consecutiveFailures += 1;
    command.health.lastFailureAt = now;
    command.health.lastError = safeMessage;
    command.updatedAt = now;
    if (command.health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) command.health.disabled = true;
    bucket.updatedAt = now;
    await this.persist();
  }

  /** 结构漂移：只标 drifted，绝不自动禁用。 */
  async markDrifted(domain: string, commandId: string): Promise<void> {
    await this.ensureLoaded();
    const bucket = this.bucket(domain);
    if (!bucket) return;
    const command = bucket.commands.find((candidate) => candidate.commandId === commandId);
    if (!command) return;
    command.health.drifted = true;
    command.updatedAt = new Date().toISOString();
    bucket.updatedAt = command.updatedAt;
    await this.persist();
  }

  /** Q11 自动加载摘要：纯本地读盘，零网络请求、零自动执行。 */
  async summary(domain: string): Promise<CommandSummary[]> {
    await this.ensureLoaded();
    const bucket = this.bucket(domain);
    if (!bucket) return [];
    return bucket.commands
      .filter((command) => !command.health.disabled && !command.deprecated)
      .map((command) => ({
        commandId: command.commandId,
        name: command.name,
        method: command.request.method,
        risk: command.risk,
        available: true,
        manuallyEdited: command.manuallyEdited,
      }));
  }

  /** 健康度报告：hits / misses / consecutiveFailures / disabled / averageDurationMs。 */
  async report(domain?: string): Promise<CacheReport> {
    await this.ensureLoaded();
    const wanted = domain ? normalizeHostname(domain) : "";
    const buckets = [...this.domains.values()].filter((bucket) => !wanted || bucket.host === wanted);
    const domains = buckets.map((bucket) => ({
      host: bucket.host,
      commandCount: bucket.commands.length,
      updatedAt: bucket.updatedAt,
    }));
    const perCommand: CacheReport["perCommand"] = [];
    for (const bucket of buckets) {
      for (const command of bucket.commands) {
        perCommand.push({
          ...toCard(command),
          hits: command.health.hits,
          misses: command.health.misses,
          consecutiveFailures: command.health.consecutiveFailures,
          disabled: command.health.disabled,
          averageDurationMs: command.health.hits > 0
            ? Math.round(command.health.totalDurationMs / command.health.hits)
            : 0,
          lastSuccessAt: command.health.lastSuccessAt,
          lastError: command.health.lastError,
        });
      }
    }
    return {
      domains,
      perCommand,
      skippedInvalid: [...this.diag.skippedInvalid],
      errors: [...this.diag.errors],
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
    };
  }

  /** 加载诊断：供 get_api_command_cache / doctor 列出 skippedInvalid[] 与 errors[]。 */
  diagnostics(): CacheLoadDiagnostics {
    return {
      skippedInvalid: [...this.diag.skippedInvalid],
      errors: [...this.diag.errors],
      ...(this.diag.backupFile ? { backupFile: this.diag.backupFile } : {}),
    };
  }
}
