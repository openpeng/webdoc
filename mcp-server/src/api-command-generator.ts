/**
 * WebPilot API 命令集 —— 稳定 commandId、命名消歧、risk / confidence 与命令组装
 * （**无 IO 纯函数管线**）。
 *
 * 硬约束：不 import node:fs、不读环境变量、不读 Date.now()（时间由 GenerateContext.now
 * 注入）、不依赖任何 MCP server 运行时单例。node:crypto.createHash 只是纯计算，不是 IO。
 *
 * 生成物零敏感值：不含 header 值 / 凭据 / 业务样本值；needsReview[].reason、
 * warnings 一律只含固定文案、命令名、字段名或计数，绝不拼接任何样本值。
 *
 * 单花括号 {id}（pathTemplate，结构 / 哈希）与双花括号 {{name}}（urlTemplate /
 * bodyTemplate / queryTemplate，渲染）严格分离，绝不混用（Q12）。
 */
import { createHash } from "node:crypto";
import {
  SCHEMA_VERSION, GENERATED_BY, EPOCH_ISO, COMMAND_NAME_PATTERN,
  VERSION_PATH_SEGMENT_RE, GENERIC_PATH_SEGMENTS, FILTER_PARAM_NAME_HINTS,
  POST_LIST_QUERY_REVIEW_REASON, NAME_CONFLICT_REVIEW_REASON,
  MISSING_SAMPLE_REVIEW_REASON, LOW_CONFIDENCE_REVIEW_REASON,
  ANALYZE_CURRENT_REVIEW_REASON, NON_JSON_BODY_REVIEW_REASON,
  UNSAFE_CONSTANT_REVIEW_REASON, NEEDS_REVIEW_DESCRIPTION_PREFIX,
  MAX_RESPONSE_FIELDS,
} from "./api-command-types.js";
import {
  normalizeHostname, endpointKey, inferParams, redactHeaderNames,
  isForbiddenParamName, isSensitiveFieldName, sanitizeParamName,
} from "./api-command-normalize.js";
import { deriveResponseFields, emptyResponseSchema } from "./api-command-response-schema.js";
import type {
  HttpMethod, Risk, EndpointGroup, ApiCommand, ApiParam, RequestTemplate,
  ResponseSchema, ReviewItem, GenerateContext, GenerationResult, CommandSourceOrigin,
} from "./api-command-types.js";

// ---------------------------------------------------------------------------
// 稳定 ID 与分组键
// ---------------------------------------------------------------------------

/**
 * commandId = "cmd_" + sha256(hostname \0 method \0 pathTemplate).hex.slice(0,10)。
 * 只包含结构信息，**人工改名不改变 commandId**（AC-05）。
 */
export function stableCommandId(domain: string, method: HttpMethod, pathTemplate: string): string {
  const host = normalizeHostname(domain);
  const digest = createHash("sha256")
    .update(`${host}\u0000${method}\u0000${pathTemplate}`, "utf8")
    .digest("hex");
  return `cmd_${digest.slice(0, 10)}`;
}

/**
 * risk 保守判定：GET / HEAD / OPTIONS → read，其余一律 write。
 * 「POST 列表查询」在人工确认前**一律 write**（Q3），其「疑似只读」只体现为
 * needsReview[]，绝不在此放宽 risk。
 */
export function classifyRisk(method: HttpMethod, group: EndpointGroup): Risk {
  void group; // 保留设计签名；looksLikePostListQuery 仅用于生成 needsReview
  return method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read" : "write";
}

/**
 * POST 列表查询疑似判定：只看**字段名**与路径静态段，绝不读取任何字段值。
 * 条件：method=POST + body 含筛选/分页类字段名 + 路径无状态变更动词。
 */
export function looksLikePostListQuery(group: EndpointGroup): boolean {
  if (!group || group.method !== "POST") return false;
  const names: string[] = [];
  for (const rec of group.records) {
    for (const field of rec.bodyFields) names.push(field.name.toLowerCase());
    for (const pair of rec.queryPairs) names.push(pair.name.toLowerCase());
  }
  const hasFilterHint = names.some((name) =>
    (FILTER_PARAM_NAME_HINTS as readonly string[]).some((hint) => name === hint || name.includes(hint)));
  const pathHasStateVerb = /(?:create|update|delete|remove|submit|cancel|publish|approve|reject|save|add|edit)/i.test(group.pathTemplate);
  return hasFilterHint && !pathHasStateVerb;
}

// ---------------------------------------------------------------------------
// 命名与消歧
// ---------------------------------------------------------------------------

function staticSegments(pathTemplate: string): string[] {
  return pathTemplate.split("/").filter((segment) => segment.length > 0);
}

function lastMeaningfulStaticSegment(pathTemplate: string): string {
  const segments = staticSegments(pathTemplate).filter((segment) => !/^\{.*\}$/.test(segment));
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function deriveVerb(method: HttpMethod, pathTemplate: string, hasListResponse: boolean): string {
  const last = lastMeaningfulStaticSegment(pathTemplate).toLowerCase();
  if (/^(?:search|find|query|lookup)$/.test(last)) return "search";
  if (hasListResponse) return "list";
  switch (method) {
    case "GET":
    case "HEAD":
    case "OPTIONS": return "get";
    case "POST": return "create";
    case "PUT":
    case "PATCH": return "update";
    case "DELETE": return "delete";
    default: return "get";
  }
}

/**
 * resource 取规范化路径模板中最后最多 2 个有意义的静态段：
 * 跳过 {id} 动态段、版本号段（v1/v2…）与通用前缀（api/rest/service）。
 * 与 verb 同名的尾段去掉，避免 `search.search`。
 */
export function deriveResource(pathTemplate: string, verb: string): string {
  const meaningful: string[] = [];
  for (const segment of staticSegments(pathTemplate)) {
    if (/^\{.*\}$/.test(segment) || /^\{\{.*\}\}$/.test(segment)) continue;
    if (VERSION_PATH_SEGMENT_RE.test(segment)) continue;
    const lower = segment.toLowerCase();
    if ((GENERIC_PATH_SEGMENTS as readonly string[]).includes(lower)) continue;
    const clean = lower
      .replace(/[^a-z0-9_.-]/g, "_")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .replace(/\.(?:json|do|action|html|php|aspx)$/i, "");
    if (clean) meaningful.push(clean);
  }
  while (meaningful.length > 0 && meaningful[meaningful.length - 1] === verb) meaningful.pop();
  const picked = meaningful.slice(-2).join(".");
  return picked || "root";
}

/** 保证命令名符合 COMMAND_NAME_PATTERN，且不含动态值 / 协议 / 端口 / query 原文。 */
export function sanitizeCommandName(raw: string): string {
  let name = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 64);
  while (/[._-]$/.test(name)) name = name.slice(0, -1);
  if (!name || !COMMAND_NAME_PATTERN.test(name)) return "cmd.root";
  return name;
}

/** 消歧限定词：取第一个合法、非敏感、非路径参数的 query / body 字段名。 */
export function findQualifier(group: EndpointGroup): string {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const rec of group.records) {
    for (const pair of rec.queryPairs) candidates.push(pair.name);
    for (const field of rec.bodyFields) candidates.push(field.name);
  }
  for (const raw of candidates) {
    const name = sanitizeParamName(raw);
    if (!name || name === "id" || seen.has(name)) continue;
    seen.add(name);
    if (isForbiddenParamName(name) || isSensitiveFieldName(name)) continue;
    if (name.length <= 20) return name;
  }
  return "";
}

/** 基于 method + pathTemplate 的确定性短哈希后缀（冲突消歧第二级，6 位 hex）。 */
export function nameConflictSuffix(method: HttpMethod, pathTemplate: string): string {
  return createHash("sha256").update(endpointKey(method, pathTemplate), "utf8").digest("hex").slice(0, 6);
}

// ---------------------------------------------------------------------------
// 请求模板构造（严格区分 {id} 与 {{name}}）
// ---------------------------------------------------------------------------

/** 把 pathTemplate 的单花括号 {id} 转成渲染用的双花括号 {{id}}。 */
export function toRenderPath(pathTemplate: string): string {
  return pathTemplate.replace(/\{([a-z0-9_]{1,64})\}/g, (_match, name: string) => `{{${name}}}`);
}

function buildQueryTemplate(params: ApiParam[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of params) {
    if (param.location !== "query") continue;
    if (param.constant && param.defaultValue !== undefined) {
      out[param.name] = String(param.defaultValue); // 仅安全字面量
    } else {
      out[param.name] = `{{${param.name}}}`;
    }
  }
  return out;
}

function buildBodyTemplate(group: EndpointGroup, params: ApiParam[]): Record<string, unknown> | null {
  const hasJsonBody = group.records.some((rec) => rec.bodyIsJson && rec.bodyFields.length > 0);
  if (!hasJsonBody) return null;
  const out: Record<string, unknown> = {};
  for (const param of params) {
    if (param.location !== "body") continue;
    if (param.constant && param.defaultValue !== undefined) {
      out[param.name] = param.defaultValue; // 保留 number / boolean 类型，绝不转字符串
    } else {
      out[param.name] = `{{${param.name}}}`;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildRequest(
  group: EndpointGroup,
  params: ApiParam[],
  domain: string,
  scheme: "http" | "https",
): RequestTemplate {
  const pathTemplate = group.pathTemplate;
  const renderedPath = toRenderPath(pathTemplate);
  const queryTemplate = buildQueryTemplate(params);
  const queryEntries = Object.entries(queryTemplate);
  const queryString = queryEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
    .join("&");
  const urlTemplate = `${scheme}://${domain}${renderedPath}${queryString ? `?${queryString}` : ""}`;
  return {
    method: group.method,
    urlTemplate,
    pathTemplate,
    bodyTemplate: buildBodyTemplate(group, params),
    queryTemplate,
  };
}

// ---------------------------------------------------------------------------
// confidence（纯数字计算，绝不引用样本值）
// ---------------------------------------------------------------------------

/** 加权 0..1；<0.6 由 generateCommands 进 needsReview。计算过程不产生任何含值字符串。 */
export function computeConfidence(group: EndpointGroup, params: ApiParam[], schema: ResponseSchema): number {
  let score = 0.5;
  const sampleCount = group.records.length;
  if (sampleCount >= 3) score += 0.15;
  else if (sampleCount >= 1) score += 0.1;
  if (schema.sampleCount > 0 && schema.fields.length > 0) score += 0.2;
  score += 0.05; // method 来源于 CDP 真实 HTTP（normalizeRecords 已剔除 XHR/fetch 伪值）
  if (group.pathParams.length > 0) score -= 0.05;
  if (group.records.some((rec) => !rec.bodyIsJson && rec.bodyFields.length > 0)) score -= 0.1;
  if (params.some((param) => typeof param.description === "string"
    && param.description.startsWith(NEEDS_REVIEW_DESCRIPTION_PREFIX))) score -= 0.1;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// needsReview 汇总（reason 只含固定文案 / 字段名 / 计数，绝不含值）
// ---------------------------------------------------------------------------

function hasSensitiveObservedField(group: EndpointGroup): boolean {
  for (const rec of group.records) {
    for (const pair of rec.queryPairs) if (isSensitiveFieldName(pair.name)) return true;
    for (const field of rec.bodyFields) if (isSensitiveFieldName(field.name)) return true;
  }
  return false;
}

function hasNonJsonBody(group: EndpointGroup): boolean {
  return group.records.some((rec) => rec.bodyFields.length > 0 && !rec.bodyIsJson);
}

function collectReviewReasons(
  group: EndpointGroup,
  params: ApiParam[],
  confidence: number,
  schema: ResponseSchema,
  nameConflictForced: boolean,
  forceNeedsReview: boolean,
  emptySchema: boolean,
): string[] {
  const reasons: string[] = [];
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (forceNeedsReview) add(ANALYZE_CURRENT_REVIEW_REASON);
  if (emptySchema || schema.sampleCount === 0 || schema.fields.length === 0) add(MISSING_SAMPLE_REVIEW_REASON);
  if (nameConflictForced) add(NAME_CONFLICT_REVIEW_REASON);
  if (looksLikePostListQuery(group)) add(POST_LIST_QUERY_REVIEW_REASON);
  if (params.some((param) => typeof param.description === "string"
    && param.description.startsWith(NEEDS_REVIEW_DESCRIPTION_PREFIX))) add(UNSAFE_CONSTANT_REVIEW_REASON);
  if (hasSensitiveObservedField(group)) add(UNSAFE_CONSTANT_REVIEW_REASON);
  if (hasNonJsonBody(group)) add(NON_JSON_BODY_REVIEW_REASON);
  if (confidence < 0.6) add(LOW_CONFIDENCE_REVIEW_REASON);
  return reasons;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * EndpointGroup[] → { commands, needsReview, redactedHeaders }。
 * 纯函数：时间由 ctx.now 注入（缺省 EPOCH_ISO）；不读文件、不读环境变量、不发请求。
 * ctx 只传设计契约的 4 个字段也完全合法；可选字段用于 analyze_current 兼容入口与
 * 目标协议推断（第 2 批 service 注入）。
 */
export function generateCommands(groups: EndpointGroup[], ctx: GenerateContext): GenerationResult {
  const domain = normalizeHostname(ctx?.domain ?? "");
  const analysisId = typeof ctx?.analysisId === "string" ? ctx.analysisId : "";
  const generatedBy = typeof ctx?.generatedBy === "string" && ctx.generatedBy ? ctx.generatedBy : GENERATED_BY;
  const now = typeof ctx?.now === "string" && ctx.now ? ctx.now : EPOCH_ISO;
  const scheme: "http" | "https" = ctx?.scheme === "http" ? "http" : "https";
  const forceEmpty = ctx?.emptyResponseSchema === true;
  const forceReview = ctx?.forceNeedsReview === true;
  const sourceOrigin: CommandSourceOrigin = ctx?.sourceOrigin === "scan"
    || ctx?.sourceOrigin === "spec" || ctx?.sourceOrigin === "manual"
    ? ctx.sourceOrigin
    : "capture";
  const schemaMap = ctx?.schema instanceof Map ? ctx.schema : new Map<string, ResponseSchema>();

  const commands: ApiCommand[] = [];
  const needsReview: ReviewItem[] = [];
  const redactedHeaders = new Set<string>();
  const usedNames = new Map<string, string>();

  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !Array.isArray(group.records) || group.records.length === 0) continue;
    // 有效 host：静态推导的候选可能自带 host（协议相对 URL 还原），
    // 它才是命令真正要打的目标；缺省才回落到扫描目标域名。
    const effectiveHost = normalizeHostname(group.host || "") || domain;
    const crossHost = !!domain && effectiveHost !== domain;
    const commandId = stableCommandId(effectiveHost, group.method, group.pathTemplate);
    const key = endpointKey(group.method, group.pathTemplate);
    const candidateSchema = forceEmpty ? undefined : schemaMap.get(key);
    const schema: ResponseSchema = candidateSchema
      ? {
          fields: candidateSchema.fields.slice(0, MAX_RESPONSE_FIELDS),
          depthLimited: candidateSchema.depthLimited === true,
          sampleCount: Number.isFinite(candidateSchema.sampleCount) ? candidateSchema.sampleCount : 0,
        }
      : emptyResponseSchema();
    const hasListResponse = schema.fields.some((field) => field.array || field.path.includes("[]"));
    const params = inferParams(group);
    const responseFields = deriveResponseFields(schema);
    const risk = classifyRisk(group.method, group);
    const confidence = computeConfidence(group, params, schema);
    const request = buildRequest(group, params, effectiveHost, scheme);

    // 命名 + 冲突逐级消歧：限定词 → 路径短哈希后缀（强制进 needsReview）。
    const verb = deriveVerb(group.method, group.pathTemplate, hasListResponse);
    const resource = deriveResource(group.pathTemplate, verb);
    let name = sanitizeCommandName(`${verb}.${resource}`);
    let nameConflictForced = false;
    if (usedNames.has(name)) {
      const qualifier = findQualifier(group);
      const withQualifier = qualifier ? sanitizeCommandName(`${name}.by_${qualifier}`) : "";
      if (withQualifier && !usedNames.has(withQualifier)) {
        name = withQualifier;
      } else {
        const suffix = nameConflictSuffix(group.method, group.pathTemplate);
        name = sanitizeCommandName(`${name}-${suffix}`);
        let serial = 2;
        while (usedNames.has(name)) {
          name = sanitizeCommandName(`${verb}.${resource}-${suffix}-${serial}`);
          serial += 1;
        }
        nameConflictForced = true;
      }
    }
    usedNames.set(name, commandId);

    // header 字段名清单（只名字，绝不存值）。
    const headerNames: string[] = [];
    for (const rec of group.records) for (const header of rec.headerNames) headerNames.push(header);
    const commandRedactedHeaders = redactHeaderNames(headerNames);
    for (const header of commandRedactedHeaders) redactedHeaders.add(header);

    const reasons = collectReviewReasons(
      group, params, confidence, schema, nameConflictForced, forceReview, forceEmpty,
    );
    for (const reason of reasons) needsReview.push({ commandId, reason });

    commands.push({
      commandId,
      name,
      domain: effectiveHost,
      risk,
      confidence,
      schemaVersion: SCHEMA_VERSION,
      manuallyEdited: false,
      deprecated: false,
      request,
      params,
      responseFields,
      responseSchema: schema,
      redactedHeaderNames: commandRedactedHeaders,
      source: {
        analysisId,
        analyzedAt: now,
        generatedBy,
        origin: sourceOrigin,
        ...(crossHost ? { crossHost: true } : {}),
      },
      health: {
        hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0,
      },
      analyzedAt: now,
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { commands, needsReview, redactedHeaders: [...redactedHeaders].sort() };
}
