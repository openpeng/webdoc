/**
 * WebPilot API 命令集 —— 编排层（T03）。
 *
 * 职责：把 7 个 MCP 工具的入参编排为「缓存读写 + 纯函数解析管线 + 扩展消息」，
 * 汇总为 AnalysisReport / ListResult / ExecuteResult 等结构化回包。
 *
 * 硬约束：
 *  1. 本文件是**唯一**允许调用 `SendFn`（发扩展消息）与读墙钟 / 环境变量的编排层；
 *     归一化 / schema / 生成 / 渲染四层保持无 IO 纯函数，时间一律由本层注入。
 *  2. 分析会话状态**不放 MCP 进程**：本层只持有 `analysisId`（跨 start/stop 关联），
 *     真正的抓取缓冲区 / 采样样本在扩展侧 `apiAnalysisSessions`（Leader/Follower 共享同一扩展）。
 *  3. 响应体样本 `samples[]` 只在本函数局部变量中流转，交给 `deriveResponseSchema()`
 *     推完 schema 后立即不再引用；**绝不进入报告、warnings、日志、缓存**（AC-04/10/20）。
 *  4. 写命令 `confirm` 闸门只在本层：未确认 → `CONFIRMATION_REQUIRED` 且**零网络请求**；
 *     `confirm` 不是安全边界，扩展侧完全不读它。
 *  5. 发给扩展的 `apiCommandExecute` 只含渲染后的 `url / method / hostname / risk /
 *     body / maxBodyChars / timeoutMs`，**不含原始 params、headers、confirm、overrides**。
 *  6. 错误分类：401/403 → `AUTH_REQUIRED`（不禁用、不计连续失败、不重试）；
 *     4xx/5xx → `HTTP_ERROR`；网络/超时 → `NETWORK_ERROR` / `EXTENSION_TIMEOUT`；
 *     结构漂移 → `drifted`（不自动禁用）；连续 4 次失败由缓存层禁用、一次成功复活。
 */
import {
  MSG, GENERATED_BY, ERROR_SAFE_MESSAGES, API_ERROR_CODES,
  MAX_ENDPOINTS_DEFAULT, MAX_RESPONSE_SAMPLES, MAX_BODY_CHARS_DEFAULT,
  API_EXEC_TIMEOUT_MS, API_EXEC_TIMEOUT_MIN_MS, API_EXEC_TIMEOUT_DEFAULT_MS,
  NO_CACHE_LIST_WARNING, ANALYZE_CURRENT_REVIEW_REASON, MISSING_SAMPLE_REVIEW_REASON,
  SITE_SCAN_KINDS, SITE_SCAN_MAX_SOURCES, SITE_SCAN_MAX_TEXT_CHARS,
  SITE_SCAN_MAX_TOTAL_BYTES, SITE_SCAN_MAX_SOURCE_BYTES, SITE_SCAN_FETCH_TIMEOUT_MS,
  SITE_SCAN_MAX_ENDPOINTS, SITE_SCAN_REVIEW_REASON, SITE_SCAN_NO_SOURCE_WARNING,
  SITE_SCAN_SOURCE_FAILED_WARNING, SITE_SCAN_CONSERVATIVE_RISK_WARNING,
  SITE_SCAN_CROSS_HOST_COMMAND_WARNING,
  SITE_SCAN_DEFAULT_LOOSE, SITE_SCAN_DEFAULT_TRUST_SPEC,
  RESPONSE_STRICT_REDACTION_DEFAULT,
  BUNDLE_COLLECT_MAX_SOURCES, BUNDLE_COLLECT_DEFAULT_SOURCES,
  BUNDLE_COLLECT_MAX_SOURCE_BYTES,
  BUNDLE_COLLECT_NO_EXTENSION_WARNING, BUNDLE_COLLECT_FAILED_WARNING,
  BUNDLE_COLLECT_EMPTY_WARNING,
  BUNDLE_COLLECT_TAB_HINT_WARNING,
} from "./api-command-types.js";
import type {
  ApiCommand, ApiParam, ApiErrorCode, AnalysisReport, AnalysisMode, AnalysisDiff,
  ListResult, ExecuteResult, CommandCard, CommandSummary, CacheReport,
  RawCapturedRecord, ResponseBodySample, ResponseSchema, NormalizedRecord,
  Risk, ReviewItem, GenerateContext, SiteScanKind, SiteScanSource,
  CompositeStepResult,
} from "./api-command-types.js";
import { ApiCommandCache } from "./api-command-cache.js";
import type { CommandPatch, ExportResult, ImportResult } from "./api-command-cache.js";
import {
  normalizeHostname, normalizeRecords, filterCandidates, templatePath,
  groupEndpoints, endpointKey, redactHeaderNames,
} from "./api-command-normalize.js";
import {
  deriveResponseSchema, redactAndProject, compareSchema, clampBodyChars,
} from "./api-command-response-schema.js";
import { generateCommands } from "./api-command-generator.js";
import { validateParams, renderRequest, previewFor, RenderError } from "./api-command-render.js";
import {
  resolveCompositeSteps, applyStepMappings,
} from "./api-command-render.js";
import type { CompositeStepPlan } from "./api-command-render.js";
import { scanSources, toScanRecords, checkScanUrl, extractFinishedCommands } from "./api-command-site-scan.js";
import { rewriteCommandHost, toCommand } from "./api-command-cache.js";
import {
  AI_ANSWER_MAX_CHARS_DEFAULT, AI_ANSWER_MAX_CHARS_LIMIT, AI_QUERY_MAX_CHARS,
  BAIDU_AI_SEARCH_ORIGIN, BAIDU_AI_SEARCH_PATH,
  BAIDU_BAIKAN_SSE_ORIGIN, BAIDU_BAIKAN_SSE_PATH,
  buildBaiduAiSearchUrl, buildBaiduBaikanRequestBody, buildBaiduBaikanSseUrl,
  extractBaiduAiAnswer, parseBaiduBaikanSse, baikanSseEnded,
} from "./baidu-ai-search.js";
import type { BaiduAiAnswer } from "./baidu-ai-search.js";

// ===========================================================================
// 对外类型（供 server.ts 组装 schema 与 case 入参）
// ===========================================================================

export type SendFn = (type: string, params: Record<string, unknown>) => Promise<any>;

/** analyze_page_apis 的 4 种 action（scan_site 为放开分级后的静态推导入口）。 */
export type AnalyzeAction = "start" | "stop_and_analyze" | "analyze_current" | "scan_site";

export interface AnalyzeArgs {
  action: AnalyzeAction;
  domain?: string;
  analysisId?: string;
  tabId?: number;
  filter?: { urlContains?: string; mimeType?: string };
  includeStaticAssets?: boolean;
  maxEndpoints?: number;
  captureResponseBody?: boolean;
  mode?: AnalysisMode;
  overwriteManual?: boolean;
  // ---- scan_site 专用（不经过扩展、不绑定 tab）----
  /** 数据源：{kind, url} 或 {kind, text}，kind ∈ js/har/openapi/commands。 */
  sources?: SiteScanSource[];
  /** 【黄区】允许内网 / 回环地址，默认 false。 */
  allowPrivateHosts?: boolean;
  /** 【黄区】允许跨 hostname 脚本源（CDN），默认 false，需同时给 extraHosts。 */
  allowCrossHost?: boolean;
  extraHosts?: string[];
  /** 规格类来源（openapi/commands）按声明方法判定 risk；默认 false = 全部按 write 保守处理。 */
  trustSpec?: boolean;
  /** 放宽 JS 路径判定，默认 false。 */
  loosePaths?: boolean;
  scanTimeoutMs?: number;
  // ---- bundle 补采（受登录态保护的 JS bundle 走扩展侧取文本）----
  /** 【绿区】URL 类数据源改由扩展侧取文本：借用页面登录态，Node 直读 401 时用。 */
  collectViaExtension?: boolean;
  /** 【绿区】从 tabId 对应页面自动发现已加载的 bundle 并补采（隐含 collectViaExtension）。 */
  discoverBundles?: boolean;
  /** 单次补采条数上限，默认 6，clamp 1..10。 */
  bundleMaxSources?: number;
  /** 是否允许 CDP 浏览器缓存层兜底（读已加载过的原始字节），默认 true。 */
  bundleUseBrowserCache?: boolean;
}

export interface ListArgs {
  domain: string;
  includeDisabled?: boolean;
  keyword?: string;
  risk?: Risk;
}

export interface GetArgs {
  domain: string;
  commandId?: string;
  name?: string;
}

export interface CallArgs {
  domain: string;
  commandId?: string;
  name?: string;
  params?: Record<string, unknown>;
  fields?: string[];
  maxBodyChars?: number;
  confirm?: boolean;
  tabId?: number;
  timeoutMs?: number;
  /** 【放开·绿区】响应敏感字段是否强制打码；缺省取 RESPONSE_STRICT_REDACTION_DEFAULT（false）。 */
  strictRedaction?: boolean;
  /** 【放开·绿区】附加请求头（Cookie / Authorization 等凭据头一律剔除）。 */
  headers?: Record<string, unknown>;
}

export interface ExportArgs {
  domain: string;
  path: string;
  includeDisabled?: boolean;
}

export interface ImportArgs {
  domain: string;
  path: string;
  overwrite?: boolean;
}

export interface UpdateArgs {  domain: string;
  commandId: string;
  name?: string;
  params?: ApiParam[];
  responseFields?: string[];
  note?: string;
  deprecated?: boolean;
}

export interface InvalidateArgs {
  domain: string;
  commandId?: string;
  /**
   * 运行期只认 disable / delete / clear_domain 三个字面量；
   * 其它值（含缺失）一律 INVALID_PARAMS，**不做缺省兜底**（AC-10）。
   */
  action: "disable" | "delete" | "clear_domain" | (string & {});
}

/** invalidate 的合法动作集合（唯一定义点）。 */
export const INVALIDATE_ACTIONS = ["disable", "delete", "clear_domain"] as const;
export type InvalidateAction = typeof INVALIDATE_ACTIONS[number];

/** 动作字面量判定：非白名单一律视为非法（不兜底、不猜测意图）。 */
export function isInvalidateAction(value: unknown): value is InvalidateAction {
  return typeof value === "string"
    && (INVALIDATE_ACTIONS as readonly string[]).includes(value);
}

/** 编排层可预期错误，携带统一错误码；server.ts 的 catch 统一转 isError:true。 */
export class ServiceError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message || ERROR_SAFE_MESSAGES[code]);
    this.name = "ServiceError";
    this.code = code;
  }
}

// ===========================================================================
// 内部工具
// ===========================================================================

const EMPTY_DIFF: AnalysisDiff = { added: 0, updated: 0, removed: 0, skipped: 0, reviewRequired: 0 };

/**
 * ai_search 的取页参数。
 *
 * 走**移动站直读**而非扩展补采：移动站 HTML 约 2MB 但 `baikan` 块结构最干净，
 * 且实测连续多次直读均返回 200（桌面站则大概率 302 到安全验证）。
 * 浏览器会话仅用于「需要登录才能看到的内容」，搜索页不需要，因此不强制开标签页。
 */
const AI_SEARCH_FETCH_TIMEOUT_MS = 15000;
const AI_SEARCH_MAX_HTML_BYTES = 12 * 1024 * 1024;
const AI_SEARCH_MAX_ATTEMPTS = 3;
/** 重试退避（毫秒）：百度风控是概率性的，隔开一点通常就能过。 */
const AI_SEARCH_RETRY_BACKOFF_MS = [800, 2200] as const;
/** SSE 生成流的整体超时：实测 3~8s 生成完，留足余量但不至于卡死调用方。 */
const AI_SEARCH_SSE_TIMEOUT_MS = 25000;
const AI_SEARCH_MAX_SSE_BYTES = 4 * 1024 * 1024;
/** 只有移动端 UA 才稳定返回 baikan 数据块（桌面端是另一套序列化，且反爬更严）。 */
const AI_SEARCH_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** SSE 接口按桌面浏览器指纹请求，与真实页面一致。 */
const AI_SEARCH_DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** 命中这些标记说明被风控拦截，HTML 里不会有答案。 */
const AI_SEARCH_BLOCKED_MARKERS = ["百度安全验证", "请完成安全验证", "网络不给力"] as const;
const AI_SEARCH_SSE_EMPTY_WARNING = "主通道返回了流但正文为空（该查询可能没有 AI 摘要），已尝试兜底通道";
const AI_SEARCH_SSE_PARTIAL_WARNING = "生成流未正常结束，收到的是部分答案（可能被超时截断）";
const AI_SEARCH_NOT_FOUND_WARNING = "该查询没有返回 AI 摘要（百度并非对所有查询都生成，换更具体或更长的问法可提高命中率）";

export interface AiSearchArgs {
  query: string;
  maxChars?: number;
  maxCitations?: number;
  timeoutMs?: number;
}

export interface AiSearchResult extends BaiduAiAnswer {
  query: string;
  /** 兜底通道的搜索页 URL 模板（不含真实查询词）。 */
  urlTemplate: string;
  /** 主通道的 SSE 接口模板（`{{query}}` 为待填查询词）。 */
  sseEndpoint: string;
  /** 实际生效的通道：`baikan-sse` / `extension:page|worker|cache` / `node`。 */
  via: string;
  durationMs: number;
  attempts: number;
  warnings: string[];
}

function emptyReport(domain: string, analysisId: string, mode: AnalysisMode): AnalysisReport {
  return {
    analysisId,
    domain,
    cacheWritten: false,
    endpointCount: 0,
    commandCount: 0,
    commands: [],
    needsReview: [],
    redactedHeaders: [],
    warnings: [],
    diff: { ...EMPTY_DIFF },
    preservedManualEdits: [],
    stale: [],
    mode,
    sampledResponseCount: 0,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** clamp timeoutMs 到 [100, 25000]，留余量避免触发 bridge 的 30s 通用超时。 */
function clampTimeoutMs(value: unknown): number {
  return clampInt(value, API_EXEC_TIMEOUT_MIN_MS, API_EXEC_TIMEOUT_MS, API_EXEC_TIMEOUT_DEFAULT_MS);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 扩展侧错误 → 结构化错误码。
 * 约定：扩展侧新命令的错误 message 形如 `<CODE>|<safe message>`；
 * 未带前缀时按关键字兜底分类，绝不把原始 message 原样回显（AC-20）。
 */
function classifyExtensionError(err: unknown): { code: ApiErrorCode; message: string } {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const known = API_ERROR_CODES as readonly string[];
  const pipe = raw.indexOf("|");
  if (pipe > 0) {
    const candidate = raw.slice(0, pipe).trim();
    if (known.includes(candidate)) {
      const rest = raw.slice(pipe + 1).trim();
      const code = candidate as ApiErrorCode;
      return { code, message: rest || ERROR_SAFE_MESSAGES[code] };
    }
  }
  const lower = raw.toLowerCase();
  if (lower.includes("not connected") || lower.includes("disconnected")) {
    return { code: "NO_EXTENSION", message: ERROR_SAFE_MESSAGES.NO_EXTENSION };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "EXTENSION_TIMEOUT", message: ERROR_SAFE_MESSAGES.EXTENSION_TIMEOUT };
  }
  if (lower.includes("emergency") || lower.includes("stopped locally")) {
    return { code: "EMERGENCY_STOPPED", message: ERROR_SAFE_MESSAGES.EMERGENCY_STOPPED };
  }
  if (lower.includes("read-only")) {
    return { code: "READ_ONLY_BLOCKED", message: ERROR_SAFE_MESSAGES.READ_ONLY_BLOCKED };
  }
  if (lower.includes("allowlist") || lower.includes("domain")) {
    return { code: "DOMAIN_NOT_ALLOWED", message: ERROR_SAFE_MESSAGES.DOMAIN_NOT_ALLOWED };
  }
  if (lower.includes("host mismatch") || lower.includes("hostname")) {
    return { code: "HOST_MISMATCH", message: ERROR_SAFE_MESSAGES.HOST_MISMATCH };
  }
  if (lower.includes("redirect")) {
    return { code: "REDIRECT_BLOCKED", message: ERROR_SAFE_MESSAGES.REDIRECT_BLOCKED };
  }
  if (lower.includes("analysis")) {
    return { code: "NO_ANALYSIS_SESSION", message: ERROR_SAFE_MESSAGES.NO_ANALYSIS_SESSION };
  }
  return { code: "NETWORK_ERROR", message: ERROR_SAFE_MESSAGES.NETWORK_ERROR };
}

/** 从抓包 URL 推断目标协议（http 站点不能一律按 https 拼 urlTemplate）。 */
function inferScheme(records: RawCapturedRecord[]): "http" | "https" {
  for (const record of records) {
    if (typeof record?.url === "string" && /^http:\/\//i.test(record.url)) return "http";
  }
  return "https";
}

/**
 * 把 Q8 样本按 `endpointKey(method, pathTemplate)` 归组，逐组推导 ResponseSchema。
 * 只产出「字段名 + 类型」，样本值在函数返回后不再被引用。
 */
function buildSchemaMap(
  kept: NormalizedRecord[],
  samples: ResponseBodySample[],
  forceEmpty: boolean,
): Map<string, ResponseSchema> {
  const schema = new Map<string, ResponseSchema>();
  if (forceEmpty) return schema;
  const keyByRequestId = new Map<string, string>();
  for (const record of kept) {
    const { pathTemplate } = templatePath(record.path);
    if (record.requestId) keyByRequestId.set(record.requestId, endpointKey(record.method, pathTemplate));
  }
  const grouped = new Map<string, ResponseBodySample[]>();
  for (const sample of samples) {
    if (!sample || typeof sample.bodyText !== "string") continue;
    const key = keyByRequestId.get(sample.requestId);
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    if (bucket.length < MAX_RESPONSE_SAMPLES) bucket.push(sample);
    grouped.set(key, bucket);
  }
  for (const [key, bucket] of grouped) {
    schema.set(key, deriveResponseSchema(bucket));
  }
  return schema;
}

// ===========================================================================
// 编排层
// ===========================================================================

export class ApiCommandService {
  private readonly cache: ApiCommandCache;
  private readonly send: SendFn;
  /** 轻量关联提示（非会话状态）：tabId → 最近一次 start 的 analysisId。 */
  private readonly lastAnalysisId = new Map<string, string>();
  private analysisSequence = 0;

  constructor(cache: ApiCommandCache, send: SendFn) {
    this.cache = cache;
    this.send = send;
  }

  /** Q11：只推荐、不执行、零网络请求 —— 纯本地缓存读取。 */
  async autoLoadSummary(domain: string): Promise<CommandSummary[]> {
    const host = normalizeHostname(domain);
    if (!host) return [];
    try {
      return await this.cache.summary(host);
    } catch {
      return [];
    }
  }

  /** 取当前标签 hostname（domain 缺省时）。getURL 是本地标签查询，不产生站点网络请求。 */
  async resolveDomain(tabId?: number): Promise<string> {
    try {
      const reply = await this.send("getURL", tabId !== undefined ? { tabId } : {});
      const url = typeof reply?.url === "string" ? reply.url : "";
      return normalizeHostname(new URL(url).hostname);
    } catch {
      return "";
    }
  }

  /** get_api_command_cache：健康度 / 跳过条目 / 加载错误。 */
  async cacheReport(domain?: string): Promise<CacheReport> {
    return this.cache.report(domain ? normalizeHostname(domain) : undefined);
  }

  /**
   * 借浏览器网络栈取搜索页（扩展三层 fallback：页面上下文 → SW → 浏览器缓存）。
   *
   * 为什么需要这条通道：Node 侧直读的 IP / TLS 指纹与真实浏览器差异明显，
   * 实测连续请求十几次后会被百度风控 —— 返回 1438 字节的「安全验证」页，
   * 且持续数十分钟不恢复。扩展侧走的是用户自己的浏览器，指纹与 Cookie 天然一致。
   *
   * 安全：URL / host 由本层构造（固定 m.baidu.com），不接收外部传入；options 只含
   * 补采白名单字段（urls/hosts/maxSources/maxBytes/timeoutMs），无法借此发出
   * 带自定义 header / cookie / body 的任意请求。回包 URL 再校验一次 host。
   */
  private async fetchSearchHtmlViaExtension(
    url: string,
    host: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; text: string; via: string }> {
    try {
      const reply = await this.send(MSG.BUNDLE_COLLECT, {
        options: {
          urls: [url],
          hosts: [host],
          discover: false,
          maxSources: 1,
          maxBytes: BUNDLE_COLLECT_MAX_SOURCE_BYTES,
          useBrowserCache: false,
          timeoutMs,
        },
      });
      const sources = Array.isArray(reply?.sources) ? reply.sources : [];
      for (const raw of sources) {
        const item = asRecord(raw);
        if (item.ok !== true) continue;
        const text = typeof item.text === "string" ? item.text : "";
        if (!text) continue;
        const finalUrl = typeof item.url === "string" ? item.url : "";
        if (finalUrl) {
          try {
            if (normalizeHostname(new URL(finalUrl).hostname) !== normalizeHostname(host)) continue;
          } catch { continue; }
        }
        return { ok: true, text, via: typeof item.via === "string" ? item.via : "" };
      }
      return { ok: false, text: "", via: "" };
    } catch {
      // 扩展未连接 / 超时：静默降级到 Node 直读，不在这里抛错。
      return { ok: false, text: "", via: "" };
    }
  }

  /**
   * ai_search —— 一句话拿到百度搜索页顶部的「AI 智能回答」。
   *
   * 两条通道：
   *  ① 主：`POST chat-ws.baidu.com/baikan/conversation` 的 SSE 生成流。
   *     实测**不需要 k_signature / pmgr_token / lid / qid**，只要 body 里带
   *     `baikan_is_high_time_demand:"1"` + `categoryIDs:[20]` 就有正文；
   *     覆盖桌面站的全部 AI 摘要，且一次调用直接拿到结构化答案 + 引用。
   *  ② 备：移动站 `m.baidu.com` 的 SSR baikan data block（AI 覆盖率低，仅兜底）。
   *
   * 为什么不做成 `call_api_command` 的一条命令：命令通道返回的是原始 body
   * （SSE 文本 / 2MB HTML），调用方还得自己解析；这里把「取 + 解析」收成一步。
   * 返回里的 `urlTemplate` / `sseEndpoint` 会标明等价接口，便于需要时直接用命令通道复用。
   *
   * 安全与隐私：只读、不带凭据、不写缓存、不进 operationLogs；`query` 只出现在请求体里，
   * 返回结构只给 URL 模板、不回显完整 URL。
   */
  async aiSearch(args: AiSearchArgs): Promise<AiSearchResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new ServiceError("INVALID_PARAMS", "query 不能为空");
    if (query.length > AI_QUERY_MAX_CHARS) {
      throw new ServiceError("INVALID_PARAMS", `query 超长（上限 ${AI_QUERY_MAX_CHARS} 字符）`);
    }

    const startedAt = Date.now();
    const timeout = clampInt(args.timeoutMs, 3000, AI_SEARCH_SSE_TIMEOUT_MS, AI_SEARCH_SSE_TIMEOUT_MS);
    // timeoutMs 是**跨通道总预算**：主通道 + 兜底通道共用一个 deadline。
    // 基线是每条通道各拿一整份 timeout，最坏总耗时翻倍（调用方以为 25s，实际可能 50s+）。
    const deadline = startedAt + timeout;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const warnings: string[] = [];

    // ① 主通道：SSE 生成流。
    const sse = await this.fetchBaikanSse(query, remaining());
    const sseAttempts = 1;
    if (sse.ok) {
      const parsed = parseBaiduBaikanSse(sse.text, {
        maxChars: args.maxChars,
        maxCitations: args.maxCitations,
      });
      if (parsed.found) {
        if (!parsed.finished) warnings.push(AI_SEARCH_SSE_PARTIAL_WARNING);
        return this.buildAiSearchResult(query, parsed, "baikan-sse", warnings, startedAt, sseAttempts);
      }
      warnings.push(AI_SEARCH_SSE_EMPTY_WARNING);
    } else {
      warnings.push(`主通道未连通（${sse.reason}），已尝试兜底通道`);
    }

    // ② 兜底：移动站 SSR data block（剩余预算为 0 时直接放弃，不再空转）。
    if (remaining() <= 0) {
      throw new ServiceError("NETWORK_ERROR", `未能取到 AI 答案：总超时预算已耗尽（${timeout}ms）`);
    }
    const fallback = await this.fetchMobileSearchHtml(query, remaining());
    if (!fallback.html) {
      throw new ServiceError("NETWORK_ERROR", `未能取到 AI 答案：${fallback.reason || "两条通道均失败"}`);
    }
    const answer = extractBaiduAiAnswer(fallback.html, {
      maxChars: args.maxChars,
      maxCitations: args.maxCitations,
    });
    if (!answer.found) {
      warnings.push(AI_SEARCH_NOT_FOUND_WARNING);
    }
    return this.buildAiSearchResult(query, answer, fallback.via, warnings, startedAt,
      sseAttempts + fallback.attempts);
  }

  /** 统一收口返回值：补 query / 通道 / 耗时 / 截断提示。 */
  private buildAiSearchResult(
    query: string,
    answer: BaiduAiAnswer,
    via: string,
    warnings: string[],
    startedAt: number,
    attempts = 1,
  ): AiSearchResult {
    const merged = [...warnings];
    if (answer.truncated) {
      merged.push(`答案已按 maxChars 截断，可调大后重试`);
    }
    return {
      ...answer,
      query,
      urlTemplate: `${BAIDU_AI_SEARCH_ORIGIN}${BAIDU_AI_SEARCH_PATH}{{query}}`,
      sseEndpoint: `${BAIDU_BAIKAN_SSE_ORIGIN}${BAIDU_BAIKAN_SSE_PATH}{{query}}`,
      via,
      durationMs: Date.now() - startedAt,
      attempts: Math.max(1, attempts),
      warnings: merged,
    };
  }

  /**
   * 主通道取流：POST 固定 body，**流式**读 SSE。
   *
   * 逐段读取（ReadableStream reader），收到结束标记（state=generate-complete / endTurn=true）
   * 立刻收尾返回 —— 不必等服务端把连接关掉。
   *
   * 只读、无凭据、无 cookie；超时或网络错误返回 ok:false 且带原因，由调用方决定是否兜底。
   */
  private async fetchBaikanSse(
    query: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; text: string; reason: string }> {
    const url = buildBaiduBaikanSseUrl(query);
    if (!url) return { ok: false, text: "", reason: "query 无法构造 SSE 地址" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "user-agent": AI_SEARCH_DESKTOP_UA,
          origin: "https://www.baidu.com",
          referer: "https://www.baidu.com/",
        },
        body: buildBaiduBaikanRequestBody(query),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, text: "", reason: `HTTP ${response.status}` };

      const stream = (response as any).body as ReadableStream<Uint8Array> | null | undefined;
      if (!stream || typeof stream.getReader !== "function") {
        // 环境不支持流式读取（老 Node / mock）：退回整段读文本。
        const text = await response.text();
        if (text.length > AI_SEARCH_MAX_SSE_BYTES) {
          return { ok: false, text: "", reason: "SSE 响应超过体积上限" };
        }
        return { ok: true, text, reason: "" };
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytes += value.byteLength ?? 0;
            if (bytes > AI_SEARCH_MAX_SSE_BYTES) {
              try { await reader.cancel(); } catch { /* 取消失败不影响返回 */ }
              return { ok: false, text: "", reason: "SSE 响应超过体积上限" };
            }
            text += decoder.decode(value, { stream: true });
          }
          // 收到结束标记就收尾：不等服务端关连接。
          if (baikanSseEnded(text)) {
            try { await reader.cancel(); } catch { /* 取消失败不影响返回 */ }
            break;
          }
        }
        text += decoder.decode();
      } catch (error) {
        // 读流中途失败：已收到的片段照样返回（半截答案优于报错）。
        if (text.length === 0) {
          const reason = error instanceof Error && error.name === "AbortError" ? "生成超时" : "网络请求失败";
          return { ok: false, text: "", reason };
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* 解锁失败不影响返回 */ }
      }
      return { ok: true, text, reason: "" };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "生成超时" : "网络请求失败";
      return { ok: false, text: "", reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 兜底通道取页：移动站搜索页 HTML。
   *
   * 顺序：扩展（浏览器指纹，绕开 Node 侧 IP 风控）→ Node 直读（带退避重试）。
   * 两条都失败时返回空 html + 原因，不抛错（由调用方决定错误文案）。
   *
   * timeoutMs 是**这一层的总预算**：扩展 + 全部重试 + 退避等待共用一个 deadline，
   * 不会因为重试次数把调用方的超时预期翻好几倍。
   */
  private async fetchMobileSearchHtml(
    query: string,
    timeoutMs: number,
  ): Promise<{ html: string; via: string; reason: string; attempts: number }> {
    const url = buildBaiduAiSearchUrl(query);
    if (!url) return { html: "", via: "", reason: "query 无法构造搜索地址", attempts: 0 };

    const deadline = Date.now() + Math.max(1, timeoutMs);
    const remaining = (): number => Math.max(0, deadline - Date.now());

    const host = new URL(url).hostname;
    // attempts 真实计数：扩展通道算一次，Node 直读每次重试各算一次。
    let attempts = 0;
    const fromExtension = await this.fetchSearchHtmlViaExtension(url, host, remaining());
    attempts += 1;
    if (fromExtension.ok) {
      return { html: fromExtension.text, via: `extension:${fromExtension.via || "unknown"}`, reason: "", attempts };
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= AI_SEARCH_MAX_ATTEMPTS; attempt += 1) {
      const budget = remaining();
      if (budget <= 0) {
        lastReason = lastReason || "总超时预算已耗尽";
        break;
      }
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": AI_SEARCH_MOBILE_UA,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9",
            referer: `${BAIDU_AI_SEARCH_ORIGIN}/`,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          lastReason = `HTTP ${response.status}`;
        } else {
          const text = await response.text();
          if (text.length > AI_SEARCH_MAX_HTML_BYTES) {
            lastReason = "搜索页超过体积上限";
          } else if (AI_SEARCH_BLOCKED_MARKERS.some((marker) => text.includes(marker))
            && !text.includes('data-for="baikan"')) {
            lastReason = "被搜索风控拦截";
          } else {
            return { html: text, via: "node", reason: "", attempts };
          }
        }
      } catch (error) {
        lastReason = error instanceof Error && error.name === "AbortError" ? "读取超时" : "网络请求失败";
      } finally {
        clearTimeout(timer);
      }
      if (attempt < AI_SEARCH_MAX_ATTEMPTS) {
        const backoff = AI_SEARCH_RETRY_BACKOFF_MS[attempt - 1] ?? 2200;
        // 退避等待也受总预算约束：预算不够睡到下一次重试就直接放弃。
        if (remaining() <= backoff) {
          lastReason = `${lastReason || "读取失败"}（总超时预算已耗尽，未继续重试）`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    const hint = lastReason === "被搜索风控拦截" ? "（百度风控拦截，稍等几十秒重试通常可恢复）" : "";
    return { html: "", via: "", reason: `${lastReason || "未知原因"}${hint}`, attempts };
  }

  /** list_api_commands：精简 CommandCard 列表 + stale / warnings。 */
  async list(args: ListArgs): Promise<ListResult> {
    const domain = normalizeHostname(args.domain);
    if (!domain) {
      return {
        domain: "", autoLoaded: true, cacheHit: false, total: 0, commands: [], stale: [],
        warnings: [NO_CACHE_LIST_WARNING],
      };
    }
    return this.cache.list(domain, {
      includeDisabled: args.includeDisabled === true,
      keyword: typeof args.keyword === "string" ? args.keyword : undefined,
      risk: args.risk === "read" || args.risk === "write" ? args.risk : undefined,
    });
  }

  /** get_api_command：单条完整定义；disabled / deprecated 视同未命中。 */
  async get(args: GetArgs): Promise<ApiCommand> {
    const domain = normalizeHostname(args.domain);
    const command = domain
      ? await this.cache.get(domain, { commandId: args.commandId, name: args.name })
      : undefined;
    if (!command) throw new ServiceError("COMMAND_NOT_FOUND");
    return command;
  }

  /** update_api_command：置 manuallyEdited=true，人工修正受 merge/full 保护。 */
  async update(args: UpdateArgs): Promise<{ updated: boolean; manuallyEdited: boolean; command: ApiCommand }> {
    const domain = normalizeHostname(args.domain);
    const patch: CommandPatch = {};
    if (typeof args.name === "string") patch.name = args.name;
    if (Array.isArray(args.params)) patch.params = args.params;
    if (Array.isArray(args.responseFields)) patch.responseFields = args.responseFields;
    if (typeof args.note === "string") patch.note = args.note;
    if (typeof args.deprecated === "boolean") patch.deprecated = args.deprecated;
    const command = domain
      ? await this.cache.update(domain, args.commandId, patch)
      : undefined;
    if (!command) throw new ServiceError("COMMAND_NOT_FOUND");
    return { updated: true, manuallyEdited: command.manuallyEdited, command };
  }

  /**
   * invalidate_api_commands：disable / delete / clear_domain。
   *
   * action 缺失或非法一律 INVALID_PARAMS，**绝不兜底成 clear_domain**（AC-10）：
   * 缺省成整域删除会让一次参数写错直接抹掉整个域名的命令集。
   */
  async invalidate(args: InvalidateArgs): Promise<{ affected: number; remaining: number }> {
    const domain = normalizeHostname(args.domain);
    const action = args.action;
    if (!isInvalidateAction(action)) {
      throw new ServiceError("INVALID_PARAMS", "action 必须是 disable / delete / clear_domain 之一");
    }
    return this.cache.invalidate(domain, { commandId: args.commandId, action });
  }

  // -------------------------------------------------------------------------
  // analyze_page_apis：start / stop_and_analyze / analyze_current
  // -------------------------------------------------------------------------

  /** 生成 `an_<紧凑 ISO>_<序号>` 关联键（时间仅用于可读性，不参与任何结构哈希）。 */
  private newAnalysisId(): string {
    this.analysisSequence += 1;
    const compact = new Date().toISOString().replace(/[-:.TZ]/g, "");
    return `an_${compact}_${String(this.analysisSequence).padStart(3, "0")}`;
  }

  private tabKey(tabId?: number): string {
    return typeof tabId === "number" && Number.isFinite(tabId) ? String(tabId) : "default";
  }

  async analyze(args: AnalyzeArgs): Promise<AnalysisReport> {
    const action = args.action;
    const mode: AnalysisMode = args.mode === "full" ? "full" : "merge";

    if (action === "start") return this.startAnalysis(args, mode);
    if (action === "analyze_current") return this.analyzeCurrent(args, mode);
    if (action === "stop_and_analyze") return this.stopAndAnalyze(args, mode);
    if (action === "scan_site") return this.scanSite(args, mode);
    throw new ServiceError("INVALID_PARAMS", "未知的 analyze action");
  }

  /** 只发 apiAnalysisStart；返回零命令的占位报告（analysisId + 可行动提示）。 */
  private async startAnalysis(args: AnalyzeArgs, mode: AnalysisMode): Promise<AnalysisReport> {
    const analysisId = typeof args.analysisId === "string" && args.analysisId.trim()
      ? args.analysisId.trim()
      : this.newAnalysisId();
    const options: Record<string, unknown> = {
      analysisId,
      includeStaticAssets: args.includeStaticAssets === true,
      maxEndpoints: clampInt(args.maxEndpoints, 1, 200, MAX_ENDPOINTS_DEFAULT),
      captureResponseBody: args.captureResponseBody === true,
    };
    const filter: Record<string, string> = {};
    if (typeof args.filter?.urlContains === "string" && args.filter.urlContains.trim()) {
      filter.urlContains = args.filter.urlContains.trim().slice(0, 200);
    }
    if (typeof args.filter?.mimeType === "string" && args.filter.mimeType.trim()) {
      filter.mimeType = args.filter.mimeType.trim().slice(0, 100);
    }
    if (Object.keys(filter).length > 0) options.filter = filter;

    const params: Record<string, unknown> = { options };
    if (typeof args.tabId === "number") params.tabId = args.tabId;
    try {
      await this.send(MSG.ANALYSIS_START, params);
    } catch (err) {
      const classified = classifyExtensionError(err);
      throw new ServiceError(classified.code, classified.message);
    }
    this.lastAnalysisId.set(this.tabKey(args.tabId), analysisId);
    const report = emptyReport(normalizeHostname(args.domain ?? ""), analysisId, mode);
    report.warnings.push(
      `分析会话已启动（analysisId=${analysisId}）。请在页面上操作目标功能，随后调用 analyze_page_apis(action="stop_and_analyze", analysisId="${analysisId}") 产出命令报告。`,
    );
    return report;
  }

  /**
   * analyze_current 兼容入口：对扩展侧现有 `networkCaptures` 缓冲区一次性解析。
   * 不新建分析会话、不采样响应体；产物强制 needsReview + 空 responseSchema。
   */
  private async analyzeCurrent(args: AnalyzeArgs, mode: AnalysisMode): Promise<AnalysisReport> {
    const analysisId = `an_current_${Date.now()}`;
    return this.runStopPipeline(args, mode, analysisId, true);
  }

  /**
   * 读取一个远端静态数据源（本层唯一允许的新 IO）。安全约束：
   *  - URL 已过 checkScanUrl()：仅 http(s)、无内嵌凭据、同源或显式放行、私网默认拒绝；
   *  - redirect:'manual' 不跟随跳转、credentials:'omit' 不带任何凭据；
   *  - 独立超时 + 单源 2MB 上限；原文只在局部变量中流转，绝不落盘 / 进日志 / 进报告。
   */
  private async fetchScanSource(url: string, timeoutMs?: number): Promise<{ ok: boolean; text: string }> {
    const timeout = clampInt(timeoutMs, 100, 30000, SITE_SCAN_FETCH_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "*/*" },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, text: "" };
      const text = await response.text();
      if (text.length > SITE_SCAN_MAX_SOURCE_BYTES) return { ok: false, text: "" };
      return { ok: true, text };
    } catch {
      return { ok: false, text: "" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 登录态补采：把「取文本」下沉到扩展侧（页面上下文 → SW → 浏览器缓存三层），
   * 本层只负责发消息 + 回包校验 + 汇总，**不做任何解析**。
   *
   * 安全约束：
   *  - 只发已过 `checkScanUrl()` 的 URL（调用方在第一遍已筛过），且回包 URL 再过一遍；
   *  - options 只含 urls / hosts / discover / maxSources / maxBytes / useBrowserCache，
   *    不含 headers / cookies / method / body —— 扩展侧也按白名单重建；
   *  - 文本只在返回值 Map 中流转，绝不进报告 / warnings / 日志 / 缓存。
   */
  private async collectBundlesViaExtension(
    args: AnalyzeArgs,
    policy: { domain: string; allowPrivateHosts?: boolean; allowCrossHost?: boolean; extraHosts?: string[] },
    urls: string[],
    warnings: Set<string>,
  ): Promise<Map<string, string>> {
    const collected = new Map<string, string>();
    const maxSources = clampInt(args.bundleMaxSources, 1, BUNDLE_COLLECT_MAX_SOURCES, BUNDLE_COLLECT_DEFAULT_SOURCES);
    const hosts = [policy.domain, ...(policy.extraHosts ?? [])].filter(Boolean);
    const params: Record<string, unknown> = {
      options: {
        urls: urls.slice(0, BUNDLE_COLLECT_MAX_SOURCES),
        hosts,
        discover: args.discoverBundles === true,
        maxSources,
        maxBytes: SITE_SCAN_MAX_SOURCE_BYTES,
        useBrowserCache: args.bundleUseBrowserCache !== false,
      },
    };
    if (typeof args.tabId === "number") params.tabId = args.tabId;

    let reply: Record<string, unknown>;
    try {
      reply = asRecord(await this.send(MSG.BUNDLE_COLLECT, params));
    } catch {
      // 扩展离线 / 超时：不阻断静态推导，退回 Node 直读。
      warnings.add(BUNDLE_COLLECT_NO_EXTENSION_WARNING);
      return collected;
    }
    for (const warning of stringArray(reply.warnings)) warnings.add(warning);

    const replied = Array.isArray(reply.sources) ? reply.sources as unknown[] : [];
    const requested = urls.slice(0, BUNDLE_COLLECT_MAX_SOURCES).length;
    for (const raw of replied) {
      const item = asRecord(raw);
      if (item.ok !== true || typeof item.text !== "string" || item.text.length === 0) continue;
      // 回包不可信：URL 必须再满足同一条同源 / 私网 / 协议策略，文本长度也必须复核。
      const verdict = checkScanUrl(String(item.url ?? ""), policy);
      if (!verdict.ok || !verdict.url) continue;
      if (item.text.length > SITE_SCAN_MAX_SOURCE_BYTES) continue;
      collected.set(verdict.url, item.text);
    }
    if (requested > 0 && collected.size < Math.min(requested, maxSources)) {
      warnings.add(BUNDLE_COLLECT_FAILED_WARNING);
    }
    if (requested === 0 && collected.size === 0) {
      warnings.add(BUNDLE_COLLECT_EMPTY_WARNING);
      // 自动发现依赖「当前标签页」。没传 tabId 时扩展取的是活动标签页，
      // 若活动页恰好是 about:blank（navigate 会新建标签页），就会静默扫错页面。
      // 空结果时把这条可能性说清楚，而不是让人以为「站点没有 bundle」。
      if (args.discoverBundles === true && typeof args.tabId !== "number") {
        warnings.add(BUNDLE_COLLECT_TAB_HINT_WARNING);
      }
    }
    return collected;
  }

  /**
   * scan_site —— 静态推导入口（放开分级后的绿区通道）。
   *
   * 与 runStopPipeline 平行：不发送任何扩展消息、不依赖 tab / debugger / 登录会话，
   * 直接由 MCP Server 读取前端产物 / 规格 / 归档流量，复用纯函数生成层与缓存层。
   * 产物强制 needsReview + 空 responseSchema；默认全部按 risk:"write" 保守处理。
   */
  private async scanSite(args: AnalyzeArgs, mode: AnalysisMode): Promise<AnalysisReport> {
    const analysisId = `an_scan_${Date.now()}`;
    const domain = normalizeHostname(args.domain ?? "");
    const report = emptyReport(domain, analysisId, mode);
    if (!domain) {
      report.warnings.push("scan_site 需要显式 domain（精确 hostname）：静态推导不绑定浏览器标签，无法按当前页面推断域名");
      return report;
    }

    const policy = {
      domain,
      allowPrivateHosts: args.allowPrivateHosts === true,
      allowCrossHost: args.allowCrossHost === true,
      extraHosts: Array.isArray(args.extraHosts)
        ? args.extraHosts.filter((item): item is string => typeof item === "string") : [],
    };
    const warnings = new Set<string>();
    const prepared: Array<{ kind: SiteScanKind; text: string }> = [];
    let totalBytes = 0;
    const rawSources = Array.isArray(args.sources) ? args.sources.slice(0, SITE_SCAN_MAX_SOURCES) : [];

    // 第一遍：先落 URL 白名单并去重。扩展补采与 Node 直读共用同一份放行清单，
    // 绝不让「Node 读不到就转扩展」变成绕过 checkScanUrl 的旁路。
    const scanUrls: string[] = [];
    const seenUrls = new Set<string>();
    for (const raw of rawSources) {
      const item = asRecord(raw);
      const kindValue = String(item.kind ?? "js");
      if (!(SITE_SCAN_KINDS as readonly string[]).includes(kindValue)) continue;
      if (typeof item.text === "string" && item.text.length > 0) continue;
      if (typeof item.url !== "string" || !item.url.trim()) continue;
      const verdict = checkScanUrl(item.url.trim(), policy);
      if (!verdict.ok || !verdict.url) {
        warnings.add(verdict.reason ?? SITE_SCAN_SOURCE_FAILED_WARNING);
        continue;
      }
      if (seenUrls.has(verdict.url)) continue;
      seenUrls.add(verdict.url);
      scanUrls.push(verdict.url);
    }

    // 登录态补采：受会话鉴权的 bundle 由扩展侧借页面上下文取文本；
    // 取到的文本仍交给下面同一个 scanSources() 解析（扫描逻辑只有一份）。
    // 【放开·绿区】scan_site 的默认输入源改为「扩展侧 bundle 发现优先 → Node 直读兜底」：
    // 扩展侧能借页面上下文看到**浏览器实际加载的全部 bundle**（Node 侧 HTML 正则通常只看到
    // 其中一小部分），且能借登录态取到受保护的脚本。前提是有 tabId；没有 tabId 时回退纯 Node。
    const hasRemoteSource = scanUrls.length > 0;
    const wantDiscovery = args.discoverBundles === true
      || (args.discoverBundles !== false && !hasRemoteSource && typeof args.tabId === "number");
    const allowExtension = args.collectViaExtension === true || wantDiscovery;
    const needExtension = allowExtension && (scanUrls.length > 0 || wantDiscovery);
    const extensionTexts = needExtension
      ? await this.collectBundlesViaExtension(args, policy, scanUrls, warnings)
      : new Map<string, string>();

    // 记录已被 sources 消费的补采 URL，剩下的才是 discover 发现的新 bundle。
    const consumedExtensionUrls = new Set<string>();
    // 输入来源分层计数：只给层级与条数，绝不回显 URL 或文本内容。
    let inlineCount = 0;
    let nodeFetchCount = 0;
    let extensionCount = 0;
    // 成品格式命令包（带 request.urlTemplate 的成品命令）：原样导入，保留
    // risk / responseFields / manuallyEdited / note —— 走「线索格式」候选管线会把它们降级丢弃。
    const finishedCommands: ApiCommand[] = [];
    for (const raw of rawSources) {
      const item = asRecord(raw);
      if (String(item.kind ?? "") !== "commands") continue;
      const text = typeof item.text === "string" ? item.text : "";
      if (!text) continue;
      const finished = extractFinishedCommands(text);
      if (finished.length === 0) continue;
      for (const rawCommand of finished) {
        const rewritten = rewriteCommandHost(rawCommand, domain);
        const rebuilt = toCommand(rewritten, domain, { skippedInvalid: [], errors: [] });
        if (rebuilt) finishedCommands.push(rebuilt);
      }
    }
    for (const raw of rawSources) {
      if (totalBytes >= SITE_SCAN_MAX_TOTAL_BYTES) { warnings.add(SITE_SCAN_SOURCE_FAILED_WARNING); break; }
      const item = asRecord(raw);
      const kindValue = String(item.kind ?? "js");
      if (!(SITE_SCAN_KINDS as readonly string[]).includes(kindValue)) continue;
      const kind = kindValue as SiteScanKind;
      let text = "";
      if (typeof item.text === "string" && item.text.length > 0) {
        text = item.text.slice(0, SITE_SCAN_MAX_TEXT_CHARS);
        inlineCount += 1;
        // 成品格式命令包已在上一步单独处理，不再进候选管线（避免字段被降级）。
        if (kind === "commands" && extractFinishedCommands(text).length > 0) continue;
      } else if (typeof item.url === "string" && item.url.trim()) {
        const verdict = checkScanUrl(item.url.trim(), policy);
        if (!verdict.ok || !verdict.url) {
          warnings.add(verdict.reason ?? SITE_SCAN_SOURCE_FAILED_WARNING);
          continue;
        }
        // 优先用扩展补采结果（含登录态）；没取到再退回 Node 直读（公开可读的 bundle）。
        text = extensionTexts.get(verdict.url) ?? "";
        if (text) { consumedExtensionUrls.add(verdict.url); extensionCount += 1; }
        if (!text) {
          const fetched = await this.fetchScanSource(verdict.url, args.scanTimeoutMs);
          if (!fetched.ok) { warnings.add(SITE_SCAN_SOURCE_FAILED_WARNING); continue; }
          text = fetched.text;
          nodeFetchCount += 1;
        }
      }
      if (!text || text.length > SITE_SCAN_MAX_SOURCE_BYTES) {
        warnings.add(SITE_SCAN_SOURCE_FAILED_WARNING);
        continue;
      }
      totalBytes += text.length;
      prepared.push({ kind, text });
    }

    // discoverBundles 发现的 bundle 不在 sources 里，若只按 sources 消费，
    // 就会出现「扩展取回 N 个、扫描读取 0 个」——取了却不用。这里把剩余补采文本
    // 作为独立 js 数据源追加，配额与 sources 共用同一套闸门。
    for (const [url, text] of extensionTexts) {
      if (consumedExtensionUrls.has(url)) continue;
      if (prepared.length >= SITE_SCAN_MAX_SOURCES) { warnings.add(SITE_SCAN_SOURCE_FAILED_WARNING); break; }
      if (totalBytes >= SITE_SCAN_MAX_TOTAL_BYTES) { warnings.add(SITE_SCAN_SOURCE_FAILED_WARNING); break; }
      if (!text || text.length > SITE_SCAN_MAX_SOURCE_BYTES) continue;
      totalBytes += text.length;
      extensionCount += 1;
      prepared.push({ kind: "js", text });
    }

    const maxEndpoints = clampInt(args.maxEndpoints, 1, SITE_SCAN_MAX_ENDPOINTS, SITE_SCAN_MAX_ENDPOINTS);
    // 输入来源层级（必须在「零候选提前返回」之前落定，否则报告里看不到层级）。
    report.bundleSource = extensionCount > 0 ? "extension"
      : nodeFetchCount > 0 ? "node-html"
      : inlineCount > 0 ? "inline"
      : "none";
    // 【放开·绿区】loosePaths 默认 true：现代站点（/x/...、/pgc/...）在保守模式下产出为 0。
    const loose = args.loosePaths === undefined ? SITE_SCAN_DEFAULT_LOOSE : args.loosePaths === true;
    const scanned = scanSources(prepared, { domain, loose, maxEndpoints });
    for (const warning of warnings) report.warnings.push(warning);
    for (const warning of scanned.warnings) {
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
    }
    if (prepared.length === 0) report.warnings.push(SITE_SCAN_NO_SOURCE_WARNING);
    if (needExtension) {
      // 只报数量与命中层级分布，绝不回显 URL 内容或原文片段。
      report.warnings.push(
        `登录态补采：请求 ${scanUrls.length} 个 URL，扩展取回 ${extensionTexts.size} 个（优先于 Node 直读）`,
      );
    }
    report.warnings.push(
      `静态推导读取 ${scanned.sourcesRead} 个数据源，产出 ${scanned.candidates.length} 个端点候选（无响应体样本）`,
    );
    if (scanned.candidates.length === 0 && finishedCommands.length === 0) return report;

    // 静态候选 → 双变体记录 → 复用现有分组与生成纯函数；schema 为空（无真实响应）。
    const records = toScanRecords(scanned.candidates, domain);
    const groups = groupEndpoints(records);
    const ctx: GenerateContext = {
      domain,
      analysisId,
      generatedBy: GENERATED_BY,
      schema: new Map(),
      now: new Date().toISOString(),
      scheme: "https",
      // needsReview 由 scan_site 自己统一收敛为 1 条来源标注，不叠加生成层的理由。
      forceNeedsReview: false,
      emptyResponseSchema: true,
      sourceOrigin: "scan",
    };
    const generated = generateCommands(groups, ctx);

    // 没有真实流量证据 → 放开后按来源声明 / 观测到的 method 判定 risk；
    // trustSpec=false 时回退「一律 write」的保守模式。
    const trustSpec = args.trustSpec === undefined ? SITE_SCAN_DEFAULT_TRUST_SPEC : args.trustSpec === true;
    const scannedCommands = trustSpec
      ? generated.commands
      : generated.commands.map((command) => ({ ...command, risk: "write" as Risk }));
    // 成品格式命令包：risk / responseFields / manuallyEdited / note 原样保留，
    // 不受 trustSpec 的保守化影响（它已经是成品，不是静态推导产物）。
    const commands = [...scannedCommands, ...finishedCommands];
    if (!trustSpec && scannedCommands.length > 0) report.warnings.push(SITE_SCAN_CONSERVATIVE_RISK_WARNING);

    // 【放开·绿区】needsReview 降为 1 条来源标注（放开前是 3 条理由叠加：
    // analyze_current 兼容入口 + 缺响应体样本 + 不安全常量 各一条）。
    const needsReview: ReviewItem[] = scannedCommands.map((command) => ({
      commandId: command.commandId,
      reason: SITE_SCAN_REVIEW_REASON,
    }));

    // 静态推导可能还原出跨 host 的候选（协议相对 URL //host/path）—— 这些命令属于
    // 各自的 host，必须按 host 分桶合并，否则缓存侧的 host 白名单重建会直接拒绝它们。
    const byHost = new Map<string, ApiCommand[]>();
    for (const command of commands) {
      const host = command.domain || domain;
      const bucket = byHost.get(host);
      if (bucket) bucket.push(command);
      else byHost.set(host, [command]);
    }

    const diff: AnalysisDiff = { added: 0, updated: 0, removed: 0, skipped: 0, reviewRequired: 0 };
    const preservedManualEdits: string[] = [];
    const stale: string[] = [];
    const freshIds = new Set(commands.map((command) => command.commandId));
    const cards: CommandCard[] = [];
    let crossHostCount = 0;
    for (const [host, hostCommands] of byHost) {
      const mergeResult = await this.cache.merge(host, hostCommands, {
        mode,
        overwriteManual: args.overwriteManual === true,
      });
      for (const warning of mergeResult.warnings) report.warnings.push(warning);
      diff.added += mergeResult.diff.added;
      diff.updated += mergeResult.diff.updated;
      diff.removed += mergeResult.diff.removed;
      diff.skipped += mergeResult.diff.skipped;
      diff.reviewRequired += mergeResult.diff.reviewRequired;
      preservedManualEdits.push(...mergeResult.preservedManualEdits);
      stale.push(...mergeResult.stale);
      const listed = await this.cache.list(host, { includeDisabled: true });
      cards.push(...listed.commands.filter((card) => freshIds.has(card.commandId)));
      crossHostCount += hostCommands.filter((command) => command.source?.crossHost === true).length;
    }
    if (crossHostCount > 0) report.warnings.push(SITE_SCAN_CROSS_HOST_COMMAND_WARNING);

    report.cacheWritten = true;
    report.endpointCount = groups.length;
    report.commandCount = commands.length;
    report.commands = cards;
    report.needsReview = needsReview;
    report.redactedHeaders = [...generated.redactedHeaders].sort();
    report.diff = {
      ...diff,
      reviewRequired: Math.max(diff.reviewRequired, needsReview.length),
    };
    report.preservedManualEdits = preservedManualEdits;
    report.stale = stale;
    report.sampledResponseCount = 0;
    return report;
  }

  private async stopAndAnalyze(args: AnalyzeArgs, mode: AnalysisMode): Promise<AnalysisReport> {
    const analysisId = typeof args.analysisId === "string" && args.analysisId.trim()
      ? args.analysisId.trim()
      : this.lastAnalysisId.get(this.tabKey(args.tabId)) || `an_stop_${Date.now()}`;
    return this.runStopPipeline(args, mode, analysisId, false);
  }

  /** start/stop 共用的解析 + 生成 + 合并 + 报告组装管线。 */
  private async runStopPipeline(
    args: AnalyzeArgs,
    mode: AnalysisMode,
    analysisId: string,
    analyzeCurrent: boolean,
  ): Promise<AnalysisReport> {
    const params: Record<string, unknown> = { options: { analysisId } };
    if (typeof args.tabId === "number") params.tabId = args.tabId;
    if (analyzeCurrent) params.analyzeCurrent = true;

    let reply: Record<string, unknown>;
    try {
      reply = asRecord(await this.send(MSG.ANALYSIS_STOP, params));
    } catch (err) {
      const classified = classifyExtensionError(err);
      throw new ServiceError(classified.code, classified.message);
    }

    // 样本只在局部变量中流转，绝不写入报告 / warnings / 日志 / 缓存。
    const records: RawCapturedRecord[] = Array.isArray(reply.records)
      ? reply.records as RawCapturedRecord[]
      : [];
    const samples: ResponseBodySample[] = analyzeCurrent || !Array.isArray(reply.samples)
      ? []
      : reply.samples as ResponseBodySample[];
    const replyAnalysisId = typeof reply.analysisId === "string" && reply.analysisId
      ? reply.analysisId
      : analysisId;
    const replyWarnings = stringArray(reply.warnings);
    const replyRedacted = stringArray(reply.redactedHeaderNames);

    let domain = normalizeHostname(args.domain ?? "");
    if (!domain && records.length > 0) {
      domain = normalizeHostname(records[0].host || records[0].url || "");
    }
    if (!domain) domain = await this.resolveDomain(args.tabId);

    const report = emptyReport(domain, replyAnalysisId, mode);
    for (const warning of replyWarnings) report.warnings.push(warning);

    if (records.length === 0) {
      report.warnings.push("本次未捕获到任何网络请求，未生成命令；请确认分析会话 / 抓包缓冲区后重试");
      return report;
    }

    // 1) 归一化 → 2) 候选过滤 → 3) 分组
    const normalized = normalizeRecords(records, domain);
    const filtered = filterCandidates(normalized, {
      includeStaticAssets: args.includeStaticAssets === true,
      maxEndpoints: clampInt(args.maxEndpoints, 1, 200, MAX_ENDPOINTS_DEFAULT),
    });
    for (const warning of filtered.warnings) report.warnings.push(warning);
    const groups = groupEndpoints(filtered.kept);

    // 4) 响应 schema：schema Map 的 key 必须是 endpointKey(method, pathTemplate)。
    const schema = buildSchemaMap(filtered.kept, samples, analyzeCurrent);
    const ctx: GenerateContext = {
      domain,
      analysisId: replyAnalysisId,
      generatedBy: GENERATED_BY,
      schema,
      now: new Date().toISOString(),
      scheme: inferScheme(records),
      forceNeedsReview: analyzeCurrent,
      emptyResponseSchema: analyzeCurrent,
    };

    // 5) 命令生成（纯函数；不读墙钟、不读环境变量）
    const generated = generateCommands(groups, ctx);
    const needsReview: ReviewItem[] = [...generated.needsReview];
    if (analyzeCurrent && generated.commands.length > 0) {
      // 兼容入口：每条命令都必须带上「强制复核」理由（幂等去重）。
      const known = new Set(needsReview.map((item) => `${item.commandId}\u0000${item.reason}`));
      for (const command of generated.commands) {
        for (const reason of [ANALYZE_CURRENT_REVIEW_REASON, MISSING_SAMPLE_REVIEW_REASON]) {
          const key = `${command.commandId}\u0000${reason}`;
          if (!known.has(key)) { known.add(key); needsReview.push({ commandId: command.commandId, reason }); }
        }
      }
    }

    // 6) 缓存合并（full / merge；人工修正保护由缓存层实现）
    const mergeResult = await this.cache.merge(domain, generated.commands, {
      mode,
      overwriteManual: args.overwriteManual === true,
    });
    for (const warning of mergeResult.warnings) report.warnings.push(warning);

    // 7) 组装报告：commands 用精简 CommandCard，完整定义留给 get_api_command。
    const listed = await this.cache.list(domain, { includeDisabled: true });
    const freshIds = new Set(generated.commands.map((command) => command.commandId));
    const cards: CommandCard[] = listed.commands.filter((card) => freshIds.has(card.commandId));

    const headerNames = new Set<string>([...generated.redactedHeaders, ...replyRedacted]);
    for (const record of records) {
      for (const name of redactHeaderNames(stringArray(record.headerNames))) headerNames.add(name);
    }

    report.cacheWritten = true;
    report.endpointCount = groups.length;
    report.commandCount = generated.commands.length;
    report.commands = cards;
    report.needsReview = needsReview;
    report.redactedHeaders = [...headerNames].sort();
    report.diff = {
      ...mergeResult.diff,
      reviewRequired: Math.max(mergeResult.diff.reviewRequired, needsReview.length),
    };
    report.preservedManualEdits = mergeResult.preservedManualEdits;
    report.stale = mergeResult.stale;
    report.sampledResponseCount = samples.length;
    return report;
  }

  // -------------------------------------------------------------------------
  // call_api_command：确认闸门 → 校验 → 渲染 → 执行 → 裁剪 → 记账
  // -------------------------------------------------------------------------

  private errorResult(
    command: Pick<ApiCommand, "commandId" | "name" | "request" | "risk"> | undefined,
    code: ApiErrorCode,
    extras: Partial<ExecuteResult> = {},
  ): ExecuteResult {
    return {
      commandId: command?.commandId ?? "",
      name: command?.name ?? "",
      request: {
        method: command?.request.method ?? "GET",
        urlTemplate: command?.request.urlTemplate ?? "",
        durationMs: 0,
      },
      status: null,
      truncated: false,
      cacheHit: command !== undefined,
      authRequired: code === "AUTH_REQUIRED",
      warnings: [],
      error: { code, message: ERROR_SAFE_MESSAGES[code] },
      ...extras,
    };
  }

  /**
   * 导出命令集为可审查 JSON（交付他人直接使用）。
   * 导出件保留来源标注、参数、响应裁剪规则与备注；不含凭据头。
   */
  async exportCommands(args: ExportArgs): Promise<ExportResult> {
    const domain = normalizeHostname(args.domain ?? "");
    const result = await this.cache.export(domain, args.path, {
      includeDisabled: args.includeDisabled === true,
    });
    return result;
  }

  /**
   * 导入他人交付的命令集。urlTemplate 的主机改写为目标域名，
   * 同名命令按 overwrite 决定覆盖或跳过。
   */
  async importCommands(args: ImportArgs): Promise<ImportResult> {
    const domain = normalizeHostname(args.domain ?? "");
    const result = await this.cache.import(domain, args.path, {
      overwrite: args.overwrite === true,
    });
    return result;
  }

  async call(args: CallArgs): Promise<ExecuteResult> {
    const domain = normalizeHostname(args.domain);
    const ref = { commandId: args.commandId, name: args.name };
    const command = domain ? await this.cache.get(domain, ref) : undefined;

    if (!command) {
      const listed = domain ? await this.cache.list(domain, { includeDisabled: true }) : undefined;
      const disabled = listed?.commands.find((card) =>
        (typeof ref.commandId === "string" && card.commandId === ref.commandId)
        || (typeof ref.name === "string" && card.name === ref.name));
      const code: ApiErrorCode = !listed || listed.total === 0
        ? "NO_CACHE"
        : disabled && disabled.disabled ? "COMMAND_DISABLED"
          : disabled && disabled.manuallyEdited ? "COMMAND_DEPRECATED"
            : "COMMAND_NOT_FOUND";
      const result = this.errorResult(undefined, code);
      result.warnings = [NO_CACHE_LIST_WARNING];
      return result;
    }

    // 【复合命令】多步编排走独立分支：预检 → 逐步行取 → 结果汇总。
    if (command.steps && command.steps.length > 0) {
      return this.callComposite(command, args, domain);
    }

    // 闸门 1（server 侧，仅防误触发）：写命令未显式确认 → 零网络请求。
    if (command.risk === "write" && args.confirm !== true) {
      return this.errorResult(command, "CONFIRMATION_REQUIRED", {
        confirmationRequired: true,
        cacheHit: true,
        preview: previewFor(command),
      });
    }

    // 参数校验：缺必填 / 类型或值级约束不符 → 零网络请求。
    const params = asRecord(args.params);
    const validation = validateParams(command, params);
    if (validation.missingParams.length > 0) {
      const result = this.errorResult(command, "MISSING_PARAMS");
      result.warnings = [`缺少必填参数：${validation.missingParams.join(", ")}；未发送任何请求`];
      return result;
    }
    if (validation.invalidParams.length > 0) {
      const result = this.errorResult(command, "INVALID_PARAMS");
      result.warnings = [`参数类型或取值不符合约束：${validation.invalidParams.join(", ")}；未发送任何请求`];
      return result;
    }

    // 渲染：path 注入防护 / query 编码 / body 保类型 / 渲染后 host 二次复核。
    let rendered: { url: string; method: ApiCommand["request"]["method"]; body?: string; headers?: Record<string, string> };
    try {
      rendered = renderRequest(command, params, args.headers);
    } catch (err) {
      if (err instanceof RenderError) {
        const result = this.errorResult(command, err.code);
        if (err.code === "MISSING_PARAMS" || err.code === "INVALID_PARAMS") {
          result.warnings = [ERROR_SAFE_MESSAGES[err.code]];
        }
        return result;
      }
      return this.errorResult(command, "INVALID_PARAMS");
    }

    const maxBodyChars = clampBodyChars(
      typeof args.maxBodyChars === "number" ? args.maxBodyChars : MAX_BODY_CHARS_DEFAULT,
    );
    const timeoutMs = clampTimeoutMs(args.timeoutMs);
    // 只下发渲染结果；绝不传原始 params / headers / confirm / overrides。
    const options: Record<string, unknown> = {
      url: rendered.url,
      method: rendered.method,
      hostname: normalizeHostname(command.domain),
      risk: command.risk,
      maxBodyChars,
      timeoutMs,
    };
    if (rendered.body !== undefined) options.body = rendered.body;
    // 【放开·绿区】请求头：非凭据头原样下发；凭据头已在渲染层剔除，扩展侧再剔一次。
    if (rendered.headers && Object.keys(rendered.headers).length > 0) options.headers = rendered.headers;
    const sendParams: Record<string, unknown> = { options };
    if (typeof args.tabId === "number") sendParams.tabId = args.tabId;

    const startedAt = Date.now();
    let reply: Record<string, unknown>;
    try {
      reply = asRecord(await this.send(MSG.COMMAND_EXECUTE, sendParams));
    } catch (err) {
      const classified = classifyExtensionError(err);
      await this.cache.recordFailure(domain, command.commandId, classified.code, classified.message);
      const result = this.errorResult(command, classified.code);
      result.request.durationMs = Date.now() - startedAt;
      return result;
    }

    const durationMs = typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
      ? Math.max(0, Math.floor(reply.durationMs))
      : Date.now() - startedAt;
    const status = typeof reply.status === "number" && Number.isFinite(reply.status)
      ? Math.floor(reply.status)
      : null;
    const warnings: string[] = [];

    // 401/403 → authRequired（不禁用、不计连续失败；缓存层对 AUTH_REQUIRED 特殊处理）。
    if (reply.authRequired === true || status === 401 || status === 403) {
      await this.cache.recordFailure(domain, command.commandId, "AUTH_REQUIRED", ERROR_SAFE_MESSAGES.AUTH_REQUIRED);
      const result = this.errorResult(command, "AUTH_REQUIRED", { status });
      result.request.durationMs = durationMs;
      result.authRequired = true;
      return result;
    }
    if (status !== null && status >= 400) {
      await this.cache.recordFailure(domain, command.commandId, "HTTP_ERROR", `HTTP ${status}`);
      const result = this.errorResult(command, "HTTP_ERROR", { status });
      result.request.durationMs = durationMs;
      return result;
    }
    // 扩展侧 fail-closed 拒绝（REDIRECT_BLOCKED / 安全策略）会带 errorCode 且 success=false。
    if (reply.success === false) {
      const code = typeof reply.errorCode === "string"
        && (API_ERROR_CODES as readonly string[]).includes(reply.errorCode)
        ? reply.errorCode as ApiErrorCode
        : "NETWORK_ERROR";
      await this.cache.recordFailure(domain, command.commandId, code, ERROR_SAFE_MESSAGES[code]);
      const result = this.errorResult(command, code);
      result.request.durationMs = durationMs;
      return result;
    }

    // 响应裁剪：白名单 + （可选）敏感字段 [REDACTED] + 数组 ≤5 + maxBodyChars 截断。
    const fieldsOverride = stringArray(args.fields);
    const fields = fieldsOverride.length > 0 ? fieldsOverride : command.responseFields;
    // 【放开·绿区】敏感字段默认不打码；传 strictRedaction=true 即回到保守模式。
    const strictRedaction = args.strictRedaction === undefined
      ? RESPONSE_STRICT_REDACTION_DEFAULT
      : args.strictRedaction === true;
    const projected = redactAndProject(reply.body, fields, maxBodyChars, undefined, strictRedaction);

    // 结构漂移检测（true = 一致）：只标 drifted，不自动禁用、不阻断返回。
    if (!reply.truncated && reply.body && typeof reply.body === "object"
      && command.responseSchema.fields.length > 0) {
      try {
        const actual = deriveResponseSchema([{
          requestId: "", contentType: typeof reply.contentType === "string" ? reply.contentType : "",
          status: status ?? 0, bodyText: JSON.stringify(reply.body), truncated: false,
        }]);
        if (!compareSchema(actual, command.responseSchema)) {
          await this.cache.markDrifted(domain, command.commandId);
          warnings.push(ERROR_SAFE_MESSAGES.DRIFTED);
        }
      } catch {
        // 漂移检测失败不影响主链路。
      }
    }

    await this.cache.recordSuccess(domain, command.commandId, durationMs);

    return {
      commandId: command.commandId,
      name: command.name,
      request: {
        method: command.request.method,
        urlTemplate: command.request.urlTemplate,  // 模板，非真实 URL（AC-20）
        durationMs,
      },
      status,
      contentType: typeof reply.contentType === "string" ? reply.contentType : undefined,
      data: projected.data,
      truncated: projected.truncated || reply.truncated === true,
      cacheHit: true,
      authRequired: false,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // 【复合命令】多步编排（JSONPath 取值 + 显式映射表）
  // -------------------------------------------------------------------------

  /**
   * 复合命令调用：按序执行子命令，上一步响应按 JSONPath 注入下一步参数。
   *
   * 关键纪律：
   *  - **预检零请求**：子命令缺失 / 写操作未确认 / 步骤静态参数不合法，全部在发请求前拦下；
   *  - **取值失败零请求**：某步的取值路径未命中上一步响应 → 该步不发请求，报 MISSING_PARAMS；
   *  - **风险只升不降**：步骤自述的 risk 不能把子命令的 write 降级成 read；
   *  - 每步各自记一次缓存健康度（真正被调用的是子命令）。
   */
  private async callComposite(
    command: ApiCommand, args: CallArgs, domain: string,
  ): Promise<ExecuteResult> {
    const plans = resolveCompositeSteps(command);
    if (plans.length === 0) {
      const result = this.errorResult(command, "INVALID_PARAMS");
      result.warnings = ["复合命令没有可用步骤；未发送任何请求"];
      return result;
    }

    // ---- 预检 1：解析全部子命令（零网络请求）----
    const resolved: Array<{ plan: CompositeStepPlan; child: ApiCommand }> = [];
    for (const plan of plans) {
      const child = await this.cache.get(domain, { commandId: plan.commandId, name: plan.name });
      if (!child) {
        const result = this.errorResult(command, "COMMAND_NOT_FOUND");
        result.warnings = [
          `第 ${plan.index + 1} 步引用的子命令不存在（${plan.commandId ?? plan.name}）；未发送任何请求`,
        ];
        return result;
      }
      if (child.steps && child.steps.length > 0) {
        const result = this.errorResult(command, "INVALID_PARAMS");
        result.warnings = [`第 ${plan.index + 1} 步引用了另一个复合命令，不支持嵌套；未发送任何请求`];
        return result;
      }
      resolved.push({ plan, child });
    }

    // ---- 预检 2：写操作确认闸门（零网络请求）----
    // 风险只升不降：子命令是 write 就一定是 write，步骤自述的 read 不能把它降级。
    const writeSteps = resolved.filter(({ plan, child }) =>
      plan.risk === "write" || child.risk === "write");
    if (command.risk === "write" || writeSteps.length > 0) {
      if (args.confirm !== true) {
        const result = this.errorResult(command, "CONFIRMATION_REQUIRED", {
          confirmationRequired: true,
          cacheHit: true,
          preview: previewFor(command),
        });
        result.warnings = [
          writeSteps.length > 0
            ? `复合命令含 ${writeSteps.length} 个写操作步骤，未确认；未发送任何请求`
            : "复合命令被标记为写操作，未确认；未发送任何请求",
        ];
        return result;
      }
    }

    // ---- 预检 3：调用方传值按「所有步骤声明的参数并集」收口 ----
    const callerParams = this.collectCompositeParams(resolved, args.params);
    const ignored = Object.keys(asRecord(args.params)).filter((key) => !(key in callerParams));
    const warnings: string[] = [];
    if (ignored.length > 0) {
      warnings.push(`参数 ${ignored.join(", ")} 未被任何步骤声明，已忽略`);
    }

    // ---- 预检 4：静态参数校验（零网络请求）----
    for (const { plan, child } of resolved) {
      const staticParams = this.staticStepParams(plan, callerParams, child);
      const declared = new Set(child.params.map((param) => param.name));
      const unknown = Object.keys(staticParams).filter((key) => !declared.has(key));
      if (unknown.length > 0) {
        const result = this.errorResult(command, "INVALID_PARAMS");
        result.warnings = [
          `第 ${plan.index + 1} 步的固定参数 ${unknown.join(", ")} 不被子命令声明；未发送任何请求`,
        ];
        return result;
      }
      // 必填缺失检查：由取值映射供给的参数不算缺失（要等上一步响应才知道）。
      const mappingSlots = new Set(plan.mappings.map((mapping) => mapping.param));
      const missing = child.params
        .filter((param) => param.required
          && !(param.constant === true && param.defaultValue !== undefined)
          && !Object.prototype.hasOwnProperty.call(staticParams, param.name)
          && !mappingSlots.has(param.name))
        .map((param) => param.name);
      if (missing.length > 0) {
        const result = this.errorResult(command, "MISSING_PARAMS");
        result.warnings = [
          `第 ${plan.index + 1} 步缺少必填参数：${missing.join(", ")}；未发送任何请求`,
        ];
        return result;
      }
    }

    // ---- 执行：按序跑，每步独立记账 ----
    const stepResults: CompositeStepResult[] = [];
    const startedAt = Date.now();
    let previousResponse: unknown;
    let lastData: unknown;
    let lastStatus: number | null = null;
    let lastContentType: string | undefined;
    let lastTruncated = false;

    for (const { plan, child } of resolved) {
      const callerForChild = this.filterParamsForCommand(callerParams, child);
      const mapped = applyStepMappings(plan, previousResponse, callerForChild);
      if (mapped.missing.length > 0) {
        const result = this.errorResult(command, "MISSING_PARAMS", { stepResults });
        result.request.durationMs = Date.now() - startedAt;
        result.warnings = [
          `第 ${plan.index + 1} 步取值失败：${mapped.missing.join(", ")}（取值路径未命中上一步响应）；该步未发送任何请求`,
          ...(stepResults.length > 0 ? [`前 ${stepResults.length} 步已执行完成`] : []),
          ...warnings,
        ];
        return result;
      }
      if (mapped.overridden.length > 0) {
        warnings.push(
          `第 ${plan.index + 1} 步的 ${mapped.overridden.join(", ")} 由取值映射决定，调用方传值未生效`,
        );
      }
      if (mapped.fallback.length > 0) {
        // 取值路径未命中 → 退化用调用方传值；与上面那条方向相反，必须分开表述。
        warnings.push(
          `第 ${plan.index + 1} 步的 ${mapped.fallback.join(", ")} 取值路径未命中，已退化为调用方传值`,
        );
      }

      // 运行时再校验一次（映射取到的值类型可能不符子命令约束）。
      const validation = validateParams(child, mapped.params);
      if (validation.missingParams.length > 0) {
        const result = this.errorResult(command, "MISSING_PARAMS", { stepResults });
        result.request.durationMs = Date.now() - startedAt;
        result.warnings = [
          `第 ${plan.index + 1} 步缺少必填参数：${validation.missingParams.join(", ")}；该步未发送任何请求`,
          ...warnings,
        ];
        return result;
      }
      if (validation.invalidParams.length > 0) {
        const result = this.errorResult(command, "INVALID_PARAMS", { stepResults });
        result.request.durationMs = Date.now() - startedAt;
        result.warnings = [
          `第 ${plan.index + 1} 步参数类型或取值不符合约束：${validation.invalidParams.join(", ")}；该步未发送任何请求`,
          ...warnings,
        ];
        return result;
      }

      const outcome = await this.executeCommandRequest(child, domain, mapped.params, args);
      stepResults.push({
        index: plan.index,
        name: child.name,
        commandId: child.commandId,
        method: child.request.method,
        urlTemplate: child.request.urlTemplate,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      if (outcome.error) {
        const result = this.errorResult(command, outcome.error.code, { stepResults });
        result.request.durationMs = Date.now() - startedAt;
        result.status = outcome.status;
        result.warnings = [
          `第 ${plan.index + 1} 步执行失败：${outcome.error.message}`,
          ...(stepResults.length > 1 ? [`前 ${stepResults.length - 1} 步已执行完成`] : []),
          ...warnings,
        ];
        return result;
      }
      previousResponse = outcome.body;
      lastData = outcome.data;
      lastStatus = outcome.status;
      lastContentType = outcome.contentType;
      lastTruncated = outcome.truncated;
    }

    const durationMs = Date.now() - startedAt;
    return {
      commandId: command.commandId,
      name: command.name,
      request: {
        method: command.request.method,
        urlTemplate: command.request.urlTemplate,  // 模板，非真实 URL（AC-20）
        durationMs,
      },
      status: lastStatus,
      ...(lastContentType ? { contentType: lastContentType } : {}),
      data: lastData,
      truncated: lastTruncated,
      cacheHit: true,
      authRequired: false,
      stepResults,
      warnings,
    };
  }

  /** 调用方传值按「所有步骤声明的参数并集」收口：未声明的参数一律不传。 */
  private collectCompositeParams(
    resolved: Array<{ plan: CompositeStepPlan; child: ApiCommand }>,
    raw: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const allowed = new Set<string>();
    for (const { child } of resolved) {
      for (const param of child.params) allowed.add(param.name);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(asRecord(raw))) {
      if (allowed.has(key)) out[key] = value;
    }
    return out;
  }

  /** 某一步的静态参数：调用方传值（该子命令声明过的）+ 步骤固定值。 */
  private staticStepParams(
    plan: CompositeStepPlan,
    callerParams: Record<string, unknown>,
    child: ApiCommand,
  ): Record<string, unknown> {
    const callerForChild = this.filterParamsForCommand(callerParams, child);
    return { ...callerForChild, ...plan.literalParams };
  }

  /** 只保留该子命令声明过的参数（跨步骤共享参数按需取用）。 */
  private filterParamsForCommand(
    callerParams: Record<string, unknown>, child: ApiCommand,
  ): Record<string, unknown> {
    const declared = new Set(child.params.map((param) => param.name));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(callerParams)) {
      if (declared.has(key)) out[key] = value;
    }
    return out;
  }

  /**
   * 单条命令的「渲染 → 发送 → 分类 → 记账」链路（复合命令各步复用）。
   *
   * 与单命令路径保持一致：只下发渲染结果，绝不传原始 params / headers / confirm；
   * 401/403 → AUTH_REQUIRED；4xx/5xx → HTTP_ERROR；扩展 fail-closed → 按 errorCode 归类。
   */
  private async executeCommandRequest(
    command: ApiCommand,
    domain: string,
    params: Record<string, unknown>,
    args: CallArgs,
  ): Promise<{
    status: number | null;
    durationMs: number;
    body: unknown;
    data: unknown;
    truncated: boolean;
    contentType?: string;
    error?: { code: ApiErrorCode; message: string };
  }> {
    let rendered: { url: string; method: ApiCommand["request"]["method"]; body?: string; headers?: Record<string, string> };
    try {
      rendered = renderRequest(command, params, args.headers);
    } catch (err) {
      if (err instanceof RenderError) {
        return {
          status: null, durationMs: 0, body: undefined, data: undefined, truncated: false,
          error: { code: err.code, message: ERROR_SAFE_MESSAGES[err.code] },
        };
      }
      return {
        status: null, durationMs: 0, body: undefined, data: undefined, truncated: false,
        error: { code: "INVALID_PARAMS", message: ERROR_SAFE_MESSAGES.INVALID_PARAMS },
      };
    }

    const maxBodyChars = clampBodyChars(
      typeof args.maxBodyChars === "number" ? args.maxBodyChars : MAX_BODY_CHARS_DEFAULT,
    );
    const timeoutMs = clampTimeoutMs(args.timeoutMs);
    const options: Record<string, unknown> = {
      url: rendered.url,
      method: rendered.method,
      hostname: normalizeHostname(command.domain),
      risk: command.risk,
      maxBodyChars,
      timeoutMs,
    };
    if (rendered.body !== undefined) options.body = rendered.body;
    if (rendered.headers && Object.keys(rendered.headers).length > 0) options.headers = rendered.headers;
    const sendParams: Record<string, unknown> = { options };
    if (typeof args.tabId === "number") sendParams.tabId = args.tabId;

    const startedAt = Date.now();
    let reply: Record<string, unknown>;
    try {
      reply = asRecord(await this.send(MSG.COMMAND_EXECUTE, sendParams));
    } catch (err) {
      const classified = classifyExtensionError(err);
      await this.cache.recordFailure(domain, command.commandId, classified.code, classified.message);
      return {
        status: null, durationMs: Date.now() - startedAt, body: undefined, data: undefined,
        truncated: false, error: classified,
      };
    }

    const durationMs = typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
      ? Math.max(0, Math.floor(reply.durationMs))
      : Date.now() - startedAt;
    const status = typeof reply.status === "number" && Number.isFinite(reply.status)
      ? Math.floor(reply.status)
      : null;

    if (reply.authRequired === true || status === 401 || status === 403) {
      await this.cache.recordFailure(domain, command.commandId, "AUTH_REQUIRED", ERROR_SAFE_MESSAGES.AUTH_REQUIRED);
      return {
        status, durationMs, body: reply.body, data: undefined, truncated: false,
        error: { code: "AUTH_REQUIRED", message: ERROR_SAFE_MESSAGES.AUTH_REQUIRED },
      };
    }
    if (status !== null && status >= 400) {
      await this.cache.recordFailure(domain, command.commandId, "HTTP_ERROR", `HTTP ${status}`);
      return {
        status, durationMs, body: reply.body, data: undefined, truncated: false,
        error: { code: "HTTP_ERROR", message: ERROR_SAFE_MESSAGES.HTTP_ERROR },
      };
    }
    if (reply.success === false) {
      const code = typeof reply.errorCode === "string"
        && (API_ERROR_CODES as readonly string[]).includes(reply.errorCode)
        ? reply.errorCode as ApiErrorCode
        : "NETWORK_ERROR";
      await this.cache.recordFailure(domain, command.commandId, code, ERROR_SAFE_MESSAGES[code]);
      return {
        status, durationMs, body: reply.body, data: undefined, truncated: false,
        error: { code, message: ERROR_SAFE_MESSAGES[code] },
      };
    }

    const fieldsOverride = stringArray(args.fields);
    const fields = fieldsOverride.length > 0 ? fieldsOverride : command.responseFields;
    const strictRedaction = args.strictRedaction === undefined
      ? RESPONSE_STRICT_REDACTION_DEFAULT
      : args.strictRedaction === true;
    const projected = redactAndProject(reply.body, fields, maxBodyChars, undefined, strictRedaction);

    // 结构漂移检测：只标 drifted，不自动禁用、不阻断返回。
    if (!reply.truncated && reply.body && typeof reply.body === "object"
      && command.responseSchema.fields.length > 0) {
      try {
        const actual = deriveResponseSchema([{
          requestId: "", contentType: typeof reply.contentType === "string" ? reply.contentType : "",
          status: status ?? 0, bodyText: JSON.stringify(reply.body), truncated: false,
        }]);
        if (!compareSchema(actual, command.responseSchema)) {
          await this.cache.markDrifted(domain, command.commandId);
        }
      } catch {
        // 漂移检测失败不影响主链路。
      }
    }

    await this.cache.recordSuccess(domain, command.commandId, durationMs);

    return {
      status,
      durationMs,
      body: reply.body,
      data: projected.data,
      truncated: projected.truncated || reply.truncated === true,
      ...(typeof reply.contentType === "string" ? { contentType: reply.contentType } : {}),
    };
  }
}
