/**
 * WebPilot API 命令集 —— 共享契约基座（类型 / 常量 / 消息 / 错误码 / 白名单）。
 *
 * ⚠️【扩展侧需同步】本文件中标注「扩展侧需同步」的常量，必须在第 2 批
 *   browser-extension/api-command-helpers.js 中以**完全一致的逐字值**重新声明。
 *   两端只共享「常量值 + 字段形状」，不共享代码；helpers 不得 import 任何 MCP 侧模块。
 *   需逐字同步的清单：MSG / MSG_RESULT / API_ERROR_CODES / TAB_SCOPED_API_MESSAGES /
 *   MAX_RESPONSE_SAMPLES / MAX_RESPONSE_SAMPLE_BYTES / SAMPLE_CANDIDATE_RESOURCE_TYPES /
 *   SAMPLE_MIME_KEYWORDS / MAX_BODY_CHARS_DEFAULT|MIN|MAX / API_EXEC_TIMEOUT_MS /
 *   START_OPTIONS_ALLOWED_KEYS / FILTER_ALLOWED_KEYS / STOP_OPTIONS_ALLOWED_KEYS /
 *   EXECUTE_OPTIONS_ALLOWED_KEYS / EXECUTE_OPTIONS_FORBIDDEN_KEYS /
 *   API_COMMAND_ALLOWED_HEADERS / API_SENSITIVE_HEADER_RE / RESPONSE_SENSITIVE_FIELDS /
 *   REDACTED_VALUE / LOG_STRIP_KEYS / API_LOG_ALLOWED_KEYS / API_LOG_PREFIX /
 *   COMMAND_NAME_PATTERN / PARAM_NAME_PATTERN。
 *
 * 本模块只含类型、常量与正则，**不含任何 IO、不含任何函数、不含任何运行时副作用**，
 * 因此可被纯函数管线、缓存管理器与 `node --test` 单元测试安全引用。
 */

// ============================================================================
// 1. 版本、文件与时间
// ============================================================================

/** 每条命令的 schema 版本；缓存文件 version 与之独立。 */
export const SCHEMA_VERSION = 1;
/** 当前代码能解释的最高 schema 版本；高于则跳过、低于则标 needsMigration。 */
export const SUPPORTED_SCHEMA_VERSION = 1;
/** 缓存文件结构版本。 */
export const CACHE_VERSION = 1;
/** 单文件缓存名（【扩展侧需同步】：仅运维/文档用，扩展不读文件）。 */
export const CACHE_FILE_NAME = "api-commands.json";
/** 与 mcp-server/package.json 的 version 保持一致；升级版本时同步此处（唯一定义点）。 */
export const GENERATED_BY = "1.1.1";
/** 纯函数管线的时间占位常量：绝不读墙钟，时间一律由调用方通过 GenerateContext.now 传入。 */
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
/** 敏感值统一掩码，不泄露原值长度。 */
export const REDACTED_VALUE = "[REDACTED]";
/** 所有新增 console 日志统一前缀，便于 doctor / 排障过滤。 */
export const API_LOG_PREFIX = "[api-command]";

// ============================================================================
// 2. 阈值常量（Q8 / Q5 / selector-cache 对齐）【扩展侧需同步】
// ============================================================================

/** 连续失败 4 次自动禁用、一次成功复活（对齐 selector-cache.ts:28）。 */
export const MAX_CONSECUTIVE_FAILURES = 4;
/** 分析默认最多保留的端点数（PRD 5.1 建议值）。 */
export const MAX_ENDPOINTS_DEFAULT = 20;
/** Q8：分析阶段响应体采样前 20 条。【扩展侧需同步】 */
export const MAX_RESPONSE_SAMPLES = 20;
/** Q8：单条响应体样本 ≤64KB（base64 解码后判断）。【扩展侧需同步】 */
export const MAX_RESPONSE_SAMPLE_BYTES = 64 * 1024;
/** 响应 schema 递归深度上限，超出标 depthLimited。 */
export const MAX_SCHEMA_DEPTH = 6;
/** 数组示例最多 5 条（Q8 / PRD 5.5）。 */
export const MAX_ARRAY_SAMPLES = 5;
/** 响应裁剪最大字符数默认值 / clamp 下界 / clamp 上界。【扩展侧需同步】 */
export const MAX_BODY_CHARS_DEFAULT = 50000;
export const MAX_BODY_CHARS_MIN = 1000;
export const MAX_BODY_CHARS_MAX = 500000;
/** 陈旧提示阈值（天）：仅提示，绝不按时间失效（Q5）。 */
export const STALE_AFTER_DAYS = 30;
/** 全局并发分析会话上限（按 tab 唯一）。【扩展侧需同步】 */
export const MAX_CONCURRENT_ANALYSES = 3;
/** 执行超时上限，必须小于 bridge.ts 的 30_000。【扩展侧需同步】 */
export const API_EXEC_TIMEOUT_MS = 25000;
/** 执行超时下限与默认值。【扩展侧需同步】 */
export const API_EXEC_TIMEOUT_MIN_MS = 100;
export const API_EXEC_TIMEOUT_DEFAULT_MS = 10000;
/** 单条命令 responseFields 白名单上限。 */
export const MAX_RESPONSE_FIELDS = 60;
/** 单条命令 responseSchema.fields 上限（防御异常嵌套）。 */
export const MAX_SCHEMA_FIELDS = 200;
/** 安全字面量字符串长度上限（主理人拍板 3：≤32 字符）。 */
export const MAX_SAFE_LITERAL_LENGTH = 32;
/**
 * 【放开·绿区】可落盘样本值的字符串长度上限。
 * 放开前落盘值必须过 isSafeLiteral（≤32 字符纯小写字母数字），
 * 真实业务值（昵称 / 订单号 / 一次性口令）一律被拦，导致命令只能带空壳参数。
 */
export const MAX_PERSISTED_VALUE_LENGTH = 200;
/**
 * 【放开·绿区】响应敏感字段是否强制打码。默认 false（不再强制 [REDACTED]）；
 * 置 true 即回到「命中敏感字段名一律 [REDACTED] 且不纳入 responseFields」的保守模式。
 */
export const RESPONSE_STRICT_REDACTION_DEFAULT = false;
/** 安全字面量「小整数」绝对值上限。 */
export const MAX_SAFE_INTEGER_ABS = 100000;
/** 人工备注长度上限。 */
export const MAX_NOTE_LENGTH = 512;
/** 脱敏后错误消息长度上限。 */
export const MAX_ERROR_MESSAGE_LENGTH = 200;
/** 路径模板长度上限。 */
export const MAX_PATH_TEMPLATE_LENGTH = 512;
/** header 字段名长度上限（只存名字，不存值）。 */
export const MAX_HEADER_NAME_LENGTH = 128;

// ============================================================================
// 3. 正则与路径归一规则（集中定义，禁止各文件另写魔法值）
// ============================================================================

/** 命令名 `<verb>.<resource>[.<qualifier>]`，复用 selector-cache 的 INTENT_PATTERN。【扩展侧需同步】 */
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 参数名。【扩展侧需同步】 */
export const PARAM_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
/** Q12：只支持 `{{name}}` 占位符，不支持 `{{page:number}}` 之类带类型标记的语法。 */
export const PARAM_PLACEHOLDER_RE = /\{\{([a-z0-9_]{1,64})\}\}/g;
/** 单个占位符完整匹配（无 g 标志，可安全反复 .test()）。 */
export const PLACEHOLDER_ONLY_RE = /^\{\{[a-z0-9_]{1,64}\}\}$/;
/** commandId = cmd_ + 10 位小写 hex。 */
export const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{10}$/;
/** 精确 hostname：小写点分、无协议/路径/端口/通配符（Q13）。 */
export const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** 响应字段白名单点路径，如 `data.items[].id`。 */
export const RESPONSE_FIELD_PATTERN = /^[a-zA-Z0-9_\-]+(?:\[\])?(?:\.[a-zA-Z0-9_\-]+(?:\[\])?)*$/;
/** 路径模板：以 / 开头，拒绝空白/引号/尖括号/反斜杠/问号/井号/冒号/星号/协议片段。 */
export const PATH_TEMPLATE_PATTERN = /^\/[^\s"'<>\\?#:*]{0,511}$/;
/** 安全字面量字符串：≤32 字符纯小写字母 / 数字 / 短连词（- 与 _）。 */
export const SAFE_LITERAL_STRING_RE = /^[a-z0-9_-]{1,32}$/;
/** 路径归一：UUID。 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 路径归一：纯数字段。 */
export const NUMERIC_SEGMENT_RE = /^\d+$/;
/** 路径归一：长 hex ID。 */
export const HEX_ID_RE = /^[0-9a-f]{16,}$/i;
/** 路径归一：≥16 位且同时含字母与数字的高熵串。 */
export const HIGH_ENTROPY_SEGMENT_RE = /^(?=.*[0-9])(?=.*[a-z])[a-z0-9_-]{16,}$/i;
/** 疑似凭据：JWT 三段式。 */
export const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** 疑似凭据：邮箱。 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 疑似凭据：手机号 / 长数字。 */
export const PHONE_RE = /^\+?\d[\d\s()-]{6,20}$/;
/** 版本号路径段（v1 / v2.1 等），命名时不作为 resource。 */
export const VERSION_PATH_SEGMENT_RE = /^v\d+(?:\.\d+)?$/i;
/** 敏感 header 名正则：字段名可展示，值绝不。【扩展侧需同步】 */
export const API_SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|proxy-authorization)$|token|secret|key|csrf|xsrf|auth/i;

// ============================================================================
// 4. 枚举与基础类型
// ============================================================================

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

export const RISKS = ["read", "write"] as const;
export type Risk = "read" | "write";

export const PARAM_LOCATIONS = ["path", "query", "body"] as const;
export type ParamLocation = "path" | "query" | "body";

export const PARAM_TYPES = ["string", "number", "boolean", "object", "array"] as const;
export type ParamType = "string" | "number" | "boolean" | "object" | "array";
export type SchemaFieldType = ParamType | "null";

export const ANALYSIS_MODES = ["full", "merge"] as const;
export type AnalysisMode = "full" | "merge";

// ============================================================================
// 5. 消息类型常量（两端逐字一致）【扩展侧需同步】
// ============================================================================

/** M→E 消息 type。回包 type = 请求 type + "Result"（见 MSG_RESULT）。 */
export const MSG = {
  ANALYSIS_START: "apiAnalysisStart",
  ANALYSIS_STOP: "apiAnalysisStop",
  COMMAND_EXECUTE: "apiCommandExecute",
  BUNDLE_COLLECT: "apiBundleCollect",
} as const;
export type ApiMessageType = typeof MSG[keyof typeof MSG];

/** E→M 回包 type；扩展侧每个 cmd* 都原样带回 requestId + success。 */
export const MSG_RESULT = {
  ANALYSIS_START: "apiAnalysisStartResult",
  ANALYSIS_STOP: "apiAnalysisStopResult",
  COMMAND_EXECUTE: "apiCommandExecuteResult",
  BUNDLE_COLLECT: "apiBundleCollectResult",
  ERROR: "error",
} as const;

/**
 * 加入 TAB_SCOPED_COMMANDS 的消息：三者都需要一个「当前会话组内的具体 tab」。
 * apiCommandExecute **不加入**（免开网页前提）。bundle 补采必须借页面上下文取登录态，
 * 因此与两个分析消息同属 tab 作用域。
 */
export const TAB_SCOPED_API_MESSAGES: readonly ApiMessageType[] = [
  MSG.ANALYSIS_START, MSG.ANALYSIS_STOP, MSG.BUNDLE_COLLECT,
];

// ============================================================================
// 6. 错误码（设计 3.1 / 7.3 全量，共 27 项）【扩展侧需同步】
// ============================================================================

export const API_ERROR_CODES = [
  "NO_CACHE", "COMMAND_NOT_FOUND", "COMMAND_DISABLED", "COMMAND_DEPRECATED",
  "MISSING_PARAMS", "INVALID_PARAMS", "UNSAFE_PATH_PARAM", "HOST_MISMATCH_AFTER_RENDER",
  "CONFIRMATION_REQUIRED", "READ_ONLY_BLOCKED", "EMERGENCY_STOPPED",
  "DOMAIN_NOT_ALLOWED", "HOST_MISMATCH", "INVALID_URL",
  "REDIRECT_BLOCKED", "AUTH_REQUIRED", "DRIFTED", "DISABLED_AFTER_FAILURES",
  "ANALYSIS_IN_PROGRESS", "NO_ANALYSIS_SESSION", "NO_EXTENSION",
  "EXTENSION_TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR",
  "MAX_ENDPOINTS_EXCEEDED", "SCHEMA_VERSION_UNSUPPORTED", "WRITE_FAILED",
] as const;

/** 全部 27 项错误码的联合类型（与 API_ERROR_CODES 逐字一致）。 */
export type ApiErrorCode = typeof API_ERROR_CODES[number];

/**
 * 错误码 → 固定中文文案。缓存 health.lastError / errors[] / 日志一律优先使用这些
 * 固定文案，绝不把外部 message 原样落盘（AC-20：errors[] 与日志不得含样本值或 header 值）。
 */
export const ERROR_SAFE_MESSAGES: Record<ApiErrorCode, string> = {
  NO_CACHE: "该域名尚无命令集，请先执行页面分析",
  COMMAND_NOT_FOUND: "未找到指定命令",
  COMMAND_DISABLED: "命令已被禁用",
  COMMAND_DEPRECATED: "命令已被标记为弃用",
  MISSING_PARAMS: "缺少必填参数，未发送任何请求",
  INVALID_PARAMS: "参数类型或取值不符合约束，未发送任何请求",
  UNSAFE_PATH_PARAM: "路径参数包含非法字符，未发送任何请求",
  HOST_MISMATCH_AFTER_RENDER: "渲染后的目标主机与命令所属域名不一致，未发送任何请求",
  CONFIRMATION_REQUIRED: "写命令需要显式确认，未发送任何请求",
  READ_ONLY_BLOCKED: "本地只读模式已拒绝写命令",
  EMERGENCY_STOPPED: "紧急停止已生效，拒绝全部命令",
  DOMAIN_NOT_ALLOWED: "目标地址不在域名白名单内",
  HOST_MISMATCH: "目标主机与命令所属域名不一致",
  INVALID_URL: "目标地址协议或格式非法",
  REDIRECT_BLOCKED: "检测到重定向，按 fail-closed 策略阻断，未跟随",
  AUTH_REQUIRED: "登录态可能已失效，请人工重新登录后重试",
  DRIFTED: "响应结构发生漂移，建议重新分析",
  DISABLED_AFTER_FAILURES: "连续失败达到上限，命令已自动禁用",
  ANALYSIS_IN_PROGRESS: "该标签页已有进行中的分析会话",
  NO_ANALYSIS_SESSION: "未找到对应的分析会话",
  NO_EXTENSION: "浏览器扩展离线或不可用",
  EXTENSION_TIMEOUT: "扩展响应超时",
  NETWORK_ERROR: "网络请求失败",
  HTTP_ERROR: "目标接口返回错误状态",
  MAX_ENDPOINTS_EXCEEDED: "端点数超过上限，已按观测频次截断",
  SCHEMA_VERSION_UNSUPPORTED: "命令 schema 版本高于当前支持版本，已跳过",
  WRITE_FAILED: "缓存写入失败（仅告警，不阻断调用链路）",
};

// ============================================================================
// 7. 白名单字段清单（三处白名单重建）【扩展侧需同步】
// ============================================================================

/** (a) 缓存加载 / 写入前 toCommand(raw, host) 允许的顶层键。 */
export const COMMAND_ALLOWED_KEYS = [
  "commandId", "name", "domain", "risk", "confidence", "schemaVersion",
  "manuallyEdited", "deprecated", "note", "request", "params", "responseFields",
  "responseSchema", "redactedHeaderNames", "source", "health",
  "analyzedAt", "lastVerifiedAt", "createdAt", "updatedAt", "steps",
] as const;

/** (a) 明确禁止的可执行 / 凭据类字段：出现即跳过整条命令（AC-17）。 */
export const COMMAND_FORBIDDEN_KEYS = [
  "computed", "script", "eval", "function", "headers", "cookie", "authorization",
  "token", "secret", "csrf", "prototype", "constructor", "__proto__",
] as const;

/**
 * (a) 复合命令**单步**允许的键：逐字段白名单重建，未知键一律丢弃。
 *
 * 与顶层 `COMMAND_ALLOWED_KEYS` 同源同纪律：steps 里绝不允许出现可执行字段
 * （script / eval / computed …），也不允许夹带凭据。
 */
export const COMMAND_STEP_ALLOWED_KEYS = [
  "name", "commandId", "params", "risk", "note",
] as const;

export const REQUEST_TEMPLATE_ALLOWED_KEYS = ["method", "urlTemplate", "pathTemplate", "bodyTemplate", "queryTemplate", "headers"] as const;
export const API_PARAM_ALLOWED_KEYS = ["name", "location", "type", "required", "description", "enumCount", "allowedValues", "constant", "defaultValue"] as const;
export const SCHEMA_FIELD_ALLOWED_KEYS = ["path", "type", "array", "isPagination", "redacted"] as const;
export const RESPONSE_SCHEMA_ALLOWED_KEYS = ["fields", "depthLimited", "sampleCount"] as const;
export const SOURCE_ALLOWED_KEYS = ["analysisId", "analyzedAt", "generatedBy", "origin", "crossHost"] as const;
export const HEALTH_ALLOWED_KEYS = [
  "hits", "misses", "consecutiveFailures", "disabled", "totalDurationMs",
  "lastSuccessAt", "lastFailureAt", "lastError", "drifted", "authRequired",
  "needsMigration", "stale",
] as const;
export const CACHE_FILE_ALLOWED_KEYS = ["version", "generatedBy", "updatedAt", "domains"] as const;
export const DOMAIN_BUCKET_ALLOWED_KEYS = ["host", "updatedAt", "commands"] as const;

/** (b) 扩展侧 msg.options 白名单。【扩展侧需同步】 */
export const START_OPTIONS_ALLOWED_KEYS = ["analysisId", "filter", "includeStaticAssets", "maxEndpoints", "captureResponseBody"] as const;
export const FILTER_ALLOWED_KEYS = ["urlContains", "mimeType"] as const;
export const STOP_OPTIONS_ALLOWED_KEYS = ["analysisId"] as const;
export const EXECUTE_OPTIONS_ALLOWED_KEYS = ["url", "method", "hostname", "risk", "body", "maxBodyChars", "timeoutMs", "headers"] as const;
/** 客户端注入这些字段一律丢弃（AC-22 关键）。【扩展侧需同步】 */
export const EXECUTE_OPTIONS_FORBIDDEN_KEYS = ["confirm", "overrides", "tabId"] as const;

/**
 * 只读模式下的**安全方法白名单**：不在表内的一律按写操作处理（fail-closed）。
 *
 * 只读门按 HTTP method 派生，**不采信客户端上报的 risk**（AC-12）——
 * risk 是客户端自述的字段，声明成 read 就能把 POST 放行，等于没有只读边界。
 * method 缺失或非法时同样按写操作拦下。
 * 【扩展侧需同步】
 */
export const READ_ONLY_SAFE_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/**
 * (c) 请求 header **最低保证集**：这两个头由代码无条件补上，不依赖调用方。
 * 【放开·绿区】放开后不再用它作上限 —— 除凭据头外的任意头都可由调用方传入。
 * 【扩展侧需同步】
 */
export const API_COMMAND_ALLOWED_HEADERS: readonly string[] = ["accept", "content-type"];

/**
 * 【放开·绿区】请求头**黑名单**：命中即静默剔除（不报错、不落盘、不进日志）。
 * 放开的是「非凭据头随便带」，凭据头永远是硬边界 —— 否则等于把登录态交给调用方。
 * 【扩展侧需同步】
 */
export const API_COMMAND_FORBIDDEN_HEADERS: readonly string[] = [
  "cookie", "authorization", "proxy-authorization", "set-cookie",
];
/** 请求头字段名合法性（RFC 7230 token），长度上限 128。 */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** 请求头值长度上限。 */
export const MAX_HEADER_VALUE_LENGTH = 512;

/** (d) 响应敏感字段黑名单：命中即 [REDACTED] 或丢弃，且不纳入 responseFields。【扩展侧需同步】 */
export const RESPONSE_SENSITIVE_FIELDS: readonly string[] = [
  "password", "token", "secret", "authorization", "cookie", "session", "csrf", "xsrf",
  "phone", "email", "id_card", "access_key", "api_key", "private_key", "credential",
];

/**
 * 工具级保留字：不得用作参数名（设计 7.1：confirm / domain / tabId / action /
 * fields / maxBodyChars 等）。刻意**不**收录 keyword / name / type / url / body /
 * method 等常见业务字段名，否则会把真实接口参数误丢弃、损害 G1 产出率。
 */
export const PARAM_RESERVED_NAMES: readonly string[] = [
  "confirm", "domain", "tabid", "action", "fields", "maxbodychars", "timeoutms", "mode",
  "overwritemanual", "includestaticassets", "captureresponsebody", "maxendpoints",
  "sessionid", "requestid", "analysisid", "risk", "commandid", "dryrun", "options",
];

/** 请求参数名黑名单 = 敏感字段名 + 工具级保留字。 */
export const REQUEST_PARAM_NAME_DENYLIST: readonly string[] = [
  ...RESPONSE_SENSITIVE_FIELDS, ...PARAM_RESERVED_NAMES,
];

// ============================================================================
// 8. 过滤 / 采样 / 命名 / 分页辅助清单【扩展侧需同步采样相关项】
// ============================================================================

/** CDP resourceType 中的静态资源类型（小写比对）。 */
export const STATIC_RESOURCE_TYPES: readonly string[] = ["document", "stylesheet", "script", "image", "font", "media"];
/** 静态资源扩展名。 */
export const STATIC_ASSET_EXTENSIONS: readonly string[] = [
  ".js", ".mjs", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".webm", ".pdf", ".zip",
];
/** 埋点 / 监控类路径关键字（始终排除，不属于可用业务端点）。 */
export const TELEMETRY_PATH_KEYWORDS: readonly string[] = [
  "/log", "/track", "/beacon", "/analytics", "/metrics", "/sentry", "/collect",
  "/telemetry", "/pixel", "/rum",
];
/** Q8 采样候选 resourceType。【扩展侧需同步】 */
export const SAMPLE_CANDIDATE_RESOURCE_TYPES: readonly string[] = ["xhr", "fetch"];
/** Q8 采样候选 mimeType 关键字（含 json 或 text/），且 status 必须 2xx。【扩展侧需同步】 */
export const SAMPLE_MIME_KEYWORDS: readonly string[] = ["json", "text/"];
/** 命名时忽略的通用路径段。 */
export const GENERIC_PATH_SEGMENTS: readonly string[] = ["api", "rest", "v1", "v2", "v3", "service", "services"];
/** 分页 / 列表字段名（schema 标 isPagination / POST 列表查询判定）。 */
export const PAGINATION_FIELD_NAMES: readonly string[] = [
  "total", "count", "page", "size", "hasmore", "has_more", "next", "nextpage", "pages",
  "limit", "offset", "pageno", "pagesize", "totalcount", "total_count",
];
/** 筛选 / 分页类参数名线索（POST 列表查询判定，只用字段名、绝不用值）。 */
export const FILTER_PARAM_NAME_HINTS: readonly string[] = [
  "page", "size", "keyword", "query", "filter", "search", "sort", "limit", "offset",
  "order", "q", "from", "to",
];

// ============================================================================
// 9. 日志脱敏规则（设计 7.6）【扩展侧需同步】
// ============================================================================

/** bridge.ts::safeParameters 必须剥离的键；get_action_log 只暴露 API_LOG_ALLOWED_KEYS。 */
export const LOG_STRIP_KEYS: readonly string[] = [
  "text", "script", "body", "params", "samples", "records", "postData", "queryParams", "headers",
];
/** 新命令日志允许出现的键；不记真实 url / body / 响应体 / 任何 header 值。 */
export const API_LOG_ALLOWED_KEYS: readonly string[] = [
  "action", "commandId", "method", "hostname", "risk", "status", "durationMs", "success",
];

// ============================================================================
// 10. 固定文案（needsReview / warnings，全部不含样本值、header 值、URL 值）
// ============================================================================

/** PRD 示例 1 固定文案：POST 列表查询人工确认前一律 write。 */
export const POST_LIST_QUERY_REVIEW_REASON = "POST 请求体为筛选与分页字段、响应为列表，疑似只读查询；人工确认前按 write 处理";
export const NAME_CONFLICT_REVIEW_REASON = "命令名冲突，已追加路径短哈希后缀，请人工重命名";
export const MISSING_SAMPLE_REVIEW_REASON = "缺少响应体样本，responseSchema 为空，建议开启 captureResponseBody 重新分析";
export const LOW_CONFIDENCE_REVIEW_REASON = "置信度低于 0.6，请人工复核参数与响应结构";
/** analyze_current 兼容入口：强制 needsReview + responseSchema 为空。 */
export const ANALYZE_CURRENT_REVIEW_REASON = "analyze_current 兼容入口不做响应体采样，产物强制需人工复核且 responseSchema 为空";
export const NON_JSON_BODY_REVIEW_REASON = "请求体不是 JSON 对象，未生成 bodyTemplate，请人工复核";
/** 不安全常量 / 敏感字段名：reason 只说原因，绝不写字段名以外的值。 */
export const UNSAFE_CONSTANT_REVIEW_REASON = "检测到不安全常量或敏感字段名，已转为必填参数或丢弃，请人工复核";
export const STALE_MANUAL_WARNING = "人工修正命令未在本次分析中观测到，已保留并标记 stale；如需删除请设置 overwriteManual=true";
export const NO_CACHE_LIST_WARNING = "该域名尚无命令集，请调用 analyze_page_apis 进行页面分析";
/** 写盘前重读磁盘缓存失败：磁盘状态未知，宁可不写，也不拿内存快照覆盖磁盘上已有的命令集。 */
export const CACHE_WRITE_SKIPPED_WARNING = "缓存写入已跳过：写盘前重读磁盘缓存失败，避免覆盖磁盘上已有的命令集";
/** 读盘失败保护：本次只写入本次新增/改动的域名，其余域名以磁盘内容为准。 */
export const CACHE_LOAD_FAILED_WARNING = "缓存读取失败，本次只写入本次新增/改动的域名，其余域名以磁盘内容为准";
/** inferParams 用此前缀标记「不安全常量已转必填参数」，generateCommands 据此生成 needsReview。 */
export const NEEDS_REVIEW_DESCRIPTION_PREFIX = "[需人工复核] ";

// ============================================================================
// 11. 抓包归一化记录与响应体样本（设计 3.2）
// ============================================================================

/** 扩展侧产出：header 只存「字段名」，绝不存值。 */
export interface RawCapturedRecord {
  requestId: string;
  url: string;
  method: string;                 // CDP 真实 HTTP method（大写）；绝不使用 XHR/fetch 伪值
  host: string;
  path: string;
  query: string;
  status: number;
  mimeType: string;
  resourceType?: string;          // CDP params.type: XHR / Fetch / Document / ...
  initiatorType?: string;
  timestamp: number;
  headerNames: string[];          // 小写字段名清单，无值
  postData?: string | null;       // 原始请求体；仅内存 + 分析回包，绝不落盘
  hasPostData: boolean;
}

/** Q8：响应体样本，仅分析期间驻留内存，stop 后立即丢弃。 */
export interface ResponseBodySample {
  requestId: string;
  contentType: string;
  status: number;
  bodyText: string;               // ≤64KB（base64 解码后）
  truncated: boolean;
}

export interface NormalizedRecord {
  requestId: string;
  host: string;
  method: HttpMethod;
  path: string;
  pathSegments: string[];
  queryPairs: Array<{ name: string; value: string }>;
  bodyFields: Array<{ name: string; value: unknown; type: ParamType }>; // 值只在内存
  bodyIsJson: boolean;
  status: number;
  mimeType: string;
  resourceType?: string;
  timestamp: number;
  headerNames: string[];
}

export interface EndpointGroup {
  method: HttpMethod;
  pathTemplate: string;           // 单花括号 {id}，用于分组与稳定哈希
  pathParams: string[];
  records: NormalizedRecord[];
  host: string;
}

// ============================================================================
// 12. 请求模板与 API 命令定义（设计 3.3）
// ============================================================================

export interface ApiParam {
  name: string;                   // PARAM_NAME_PATTERN
  location: ParamLocation;
  type: ParamType;
  required: boolean;
  description?: string;
  enumCount?: number;             // Q14：只记「观测到 N 个取值」，不记真实值
  allowedValues?: Array<string | number | boolean>; // 仅人工显式写入且通过 isSafeLiteral
  constant?: boolean;             // 观测期间取值恒定
  defaultValue?: string | number | boolean;        // 仅安全字面量（主理人拍板 3）
}

export interface SchemaField {
  path: string;                   // 点路径 + [] 标记，如 "data.items[].id"
  type: SchemaFieldType;
  array: boolean;
  isPagination?: boolean;
  redacted?: boolean;             // 命中敏感字段黑名单
}

export interface ResponseSchema {
  fields: SchemaField[];
  depthLimited: boolean;
  sampleCount: number;            // 参与推导的样本条数（不含值）
}

/** 单花括号 {id} 用于结构标识；双花括号 {{name}} 用于渲染（Q12），两者不可混用。 */
export interface RequestTemplate {
  method: HttpMethod;
  urlTemplate: string;            // 绝对 URL 模板，含 {{param}}；host 精确 === domain
  pathTemplate: string;           // 含 {id} 的规范化路径
  bodyTemplate?: Record<string, unknown> | null;  // 只含安全字面量与 "{{param}}" 占位
  queryTemplate?: Record<string, string>;
  /** 【放开·绿区】命令自带的请求头模板：值可以是字面量或 "{{param}}" 占位。 */
  headers?: Record<string, string>;
}

export interface CommandHealth {
  hits: number;
  misses: number;
  consecutiveFailures: number;
  disabled: boolean;
  totalDurationMs: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  drifted?: boolean;
  authRequired?: boolean;
  needsMigration?: boolean;
  stale?: boolean;
}

export interface ApiCommand {
  commandId: string;              // cmd_<10 hex>
  name: string;                   // <verb>.<resource>[.<qualifier>]
  domain: string;                 // 精确 hostname
  risk: Risk;
  confidence: number;             // 0..1
  schemaVersion: number;          // 1
  manuallyEdited: boolean;
  deprecated: boolean;
  note?: string;
  request: RequestTemplate;
  params: ApiParam[];
  responseFields: string[];       // 白名单点路径
  responseSchema: ResponseSchema;
  redactedHeaderNames: string[];  // 字段名清单，无值
  source: ApiCommandSource;
  health: CommandHealth;
  analyzedAt: string;
  lastVerifiedAt: string;
  createdAt: string;
  updatedAt: string;
  /** 【复合命令】多步编排：按序执行的子命令链；有 steps 时 request 仅为占位模板。 */
  steps?: CommandStep[];
}

/**
 * 复合命令的一步。
 *
 * 入参 `params` 支持两种写法：
 *  - **字面量**：`{"page": 1}` —— 直接传给子命令；
 *  - **取值映射**：`{"orderId": {"from": "$.data.order.id"}}` ——
 *    从**上一步的响应**按 JSONPath 取值后注入（2026-11-05 用户拍板：JSONPath + 显式映射表）。
 *
 * `from` 只接受 JSONPath 子集（`$` 根 + `.name` / `["name"]` + `[n]` / `[*]`），
 * 不支持过滤表达式、脚本与通配递归 —— 避免变成可执行表达式。
 */
export interface CommandStep {
  /** 子命令名（<verb>.<resource>）或 commandId，二选一。 */
  name?: string;
  commandId?: string;
  /** 该步入参：字面量或 {"from": "<jsonpath>"} 取值映射。 */
  params?: Record<string, unknown>;
  /** 该步的风险覆盖（缺省按子命令自身的 risk 判定）。 */
  risk?: Risk;
  /** 该步的 notes（审计用，不含值）。 */
  note?: string;
}

/** 复合命令允许的最大步数（防御超长编排）。 */
export const MAX_COMPOSITE_STEPS = 5;
/** 单条 JSONPath 的最大长度。 */
export const MAX_JSONPATH_LENGTH = 256;
/** JSONPath 允许的段数上限。 */
export const MAX_JSONPATH_SEGMENTS = 16;

/**
 * 命令来源标注：让「这条命令是怎么来的」可追溯、可审查、可交付。
 * - capture：真实抓包观测（最可信）
 * - scan：静态推导（前端代码 / 规格 / 归档流量，未经真实响应验证）
 * - spec：来自 OpenAPI / 声明式命令包等权威规格
 * - manual：人工录入或人工修正
 */
export const COMMAND_SOURCE_ORIGINS = ["capture", "scan", "spec", "manual"] as const;
export type CommandSourceOrigin = typeof COMMAND_SOURCE_ORIGINS[number];

export interface ApiCommandSource {
  analysisId: string;
  analyzedAt: string;
  generatedBy: string;
  /** 来源类型；旧缓存缺失时按 capture 兜底（历史命令均来自抓包）。 */
  origin?: CommandSourceOrigin;
  /**
   * 跨 host 标记：静态推导从协议相对 URL（//host/path）还原出候选自带 host，
   * 且该 host 与调用方传入的 domain 不同时置 true。执行时仍走扩展侧域名白名单。
   */
  crossHost?: boolean;
}

/** 对外精简视图（analyze / list 返回）。 */
export interface CommandCard {
  commandId: string;
  name: string;
  method: HttpMethod;
  pathTemplate: string;
  /** 请求模板（不含任何 header 值与业务样本值）；调用方据此拼最终 URL。 */
  urlTemplate?: string;
  risk: Risk;
  confidence?: number;
  params?: ApiParam[];
  paramNames: string[];
  responseFields: string[];
  manuallyEdited: boolean;
  disabled: boolean;
  drifted?: boolean;
  schemaVersion: number;
  updatedAt: string;
}

/** Q11：注入 navigate / probe 的极简摘要，只推荐不执行。 */
export interface CommandSummary {
  commandId: string;
  name: string;
  method: HttpMethod;
  risk: Risk;
  available: boolean;             // !disabled && !deprecated
  manuallyEdited: boolean;
}

// ============================================================================
// 13. 缓存文件结构（设计 3.4）
// ============================================================================

/** 单文件 api-commands.json，按 hostname 分组（Q4）。 */
export interface ApiCommandCacheFile {
  version: 1;
  generatedBy: string;            // WebPilot 版本
  updatedAt: string;              // ISO 8601 UTC
  domains: Record<string, DomainBucket>;
}
export interface DomainBucket {
  host: string;                   // 精确 hostname（小写）
  updatedAt: string;
  commands: ApiCommand[];
}
export interface CacheLoadDiagnostics {
  skippedInvalid: Array<{ host: string; commandId?: string; reason: string }>;
  errors: Array<{ source: string; error: string }>;
  backupFile?: string;            // *.corrupt-<ts>
  loadFailed?: boolean;           // 读盘失败（IO 错误 / 结构非法）：本进程没有可信磁盘视图
}
export interface CacheReport {
  domains: Array<{ host: string; commandCount: number; updatedAt: string }>;
  perCommand: Array<CommandCard & {
    hits: number; misses: number; consecutiveFailures: number; disabled: boolean;
    averageDurationMs: number; lastSuccessAt?: string; lastError?: string;
  }>;
  skippedInvalid: CacheLoadDiagnostics["skippedInvalid"];
  errors: CacheLoadDiagnostics["errors"];
  schemaVersion: number;
}

// ============================================================================
// 14. 分析报告与执行结果（设计 3.5）
// ============================================================================

export interface AnalysisDiff {
  added: number; updated: number; removed: number; skipped: number; reviewRequired: number;
}
export interface ReviewItem { commandId: string; reason: string; }

export interface AnalysisReport {
  analysisId: string;
  domain: string;
  cacheWritten: boolean;
  endpointCount: number;
  commandCount: number;
  commands: CommandCard[];
  needsReview: ReviewItem[];
  redactedHeaders: string[];      // 字段名清单，无值
  warnings: string[];
  diff: AnalysisDiff;
  preservedManualEdits: string[];
  stale: string[];
  mode: AnalysisMode;
  sampledResponseCount: number;   // 只给计数，不给样本值
  /**
   * 静态推导实际使用的输入来源层级（scan_site）：
   * `extension` = 扩展侧借页面上下文发现 / 取回的 bundle；`node-html` = 纯 Node 直读；
   * `inline` = 只用了调用方内联文本。其它分析动作为 undefined。
   */
  bundleSource?: string;
}

export interface ListResult {
  domain: string;
  autoLoaded: boolean;
  cacheHit: boolean;
  total: number;
  commands: CommandCard[];
  stale: string[];
  warnings: string[];
}

export interface ExecuteResult {
  commandId: string;
  name: string;
  request: { method: HttpMethod; urlTemplate: string; durationMs: number };
  status: number | null;
  contentType?: string;
  data?: unknown;                 // 裁剪 + 脱敏 + 截断后的数据
  truncated: boolean;
  cacheHit: boolean;
  authRequired: boolean;
  confirmationRequired?: boolean;
  preview?: { method: HttpMethod; urlTemplate: string; paramNames: string[]; risk: Risk };
  /** 【复合命令】各步执行结果（按序）；单命令调用时不存在。 */
  stepResults?: CompositeStepResult[];
  warnings: string[];
  error?: { code: ApiErrorCode; message: string };
}

/**
 * 【复合命令】单步执行结果。
 *
 * 只含结构信息与已裁剪的数据，绝不含原始入参值（AC-20）。
 */
export interface CompositeStepResult {
  index: number;
  name: string;
  commandId: string;
  method: HttpMethod;
  urlTemplate: string;
  status: number | null;
  durationMs: number;
  data?: unknown;
  error?: { code: ApiErrorCode; message: string };
}

// ============================================================================
// 15. 扩展消息 Envelope（设计 3.6）【扩展侧需同步字段形状】
// ============================================================================

/** bridge.send 自动附加 requestId / sessionId / agentKey / agentScope（bridge.ts:517-525）。 */
export interface ApiExtensionRequest<T = Record<string, unknown>> {
  type: ApiMessageType;
  requestId: number;
  sessionId: string;
  agentKey?: string;
  agentScope?: "session" | "host";
  tabId?: number;                 // 分析用；执行可省略（主理人拍板 4）
  analysisId?: string;
  options: T;                     // 扩展侧必须经 rebuild*Options 白名单重建
}
export interface AnalysisStartOptions {
  analysisId: string;
  filter?: { urlContains?: string; mimeType?: string };
  includeStaticAssets: boolean;   // 默认 false
  maxEndpoints: number;           // 默认 20
  captureResponseBody: boolean;   // Q8 默认 false
}
export interface AnalysisStopOptions { analysisId: string; }

export interface AnalysisStopResult {
  success: boolean;
  analysisId: string;
  records: RawCapturedRecord[];
  samples: ResponseBodySample[];  // Q8：仅在分析期间存在
  redactedHeaderNames: string[];
  warnings: string[];
  sampledResponseCount: number;
  error?: string;
}

/** 注意：无 headers 字段、无 confirm 字段、无 overrides —— 扩展侧不接收。 */
export interface CommandExecuteOptions {
  url: string;                    // 已渲染的最终 URL（非模板）
  method: HttpMethod;
  hostname: string;               // 精确 hostname（Q13）
  risk: Risk;
  body?: string | null;
  maxBodyChars: number;
  timeoutMs: number;
}
export interface CommandExecuteResult {
  success: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: unknown;                 // json 或截断文本
  bodyLength?: number;
  truncated: boolean;
  durationMs: number;
  redirected?: boolean;
  error?: string;
  errorCode?: ApiErrorCode;
}

// ============================================================================
// 16. 纯函数管线的输入 / 输出类型（具名导出，供 QA 从 dist/ 直接引用）
// ============================================================================

export interface FilterCandidatesOptions {
  includeStaticAssets: boolean;
  maxEndpoints: number;
}
export interface FilterResult {
  kept: NormalizedRecord[];
  ignored: number;
  warnings: string[];
}
export interface PathTemplateResult {
  pathTemplate: string;
  pathParams: string[];
}
export interface ParsedBodyFields {
  fields: Array<{ name: string; value: unknown; type: ParamType }>;
  isJson: boolean;
}
export interface ProjectResult {
  data: unknown;
  truncated: boolean;
  redactedFields: string[];
}
/**
 * generateCommands 上下文。前 4 个字段是设计 3.7 契约；后 4 个为**可选**扩展：
 *  - now：纯函数不读墙钟，时间由调用方注入（缺省 EPOCH_ISO）
 *  - scheme：目标协议（默认 https），由 T03 从抓包 url 推断
 *  - forceNeedsReview / emptyResponseSchema：analyze_current 兼容入口强制标记
 * 只传前 4 个字段完全合法，不破坏设计签名。
 */
export interface GenerateContext {
  domain: string;
  analysisId: string;
  generatedBy: string;
  schema: Map<string, ResponseSchema>;
  now?: string;
  scheme?: "http" | "https";
  forceNeedsReview?: boolean;
  emptyResponseSchema?: boolean;
  /** 来源标注：capture（抓包）/ scan（静态推导）/ spec（规格）/ manual（人工）。 */
  sourceOrigin?: CommandSourceOrigin;
  /** 扫描目标域名；候选自带 host 且与之不同时，命令标记 crossHost。 */
  crossHostBaseDomain?: string;
  /** 【放开·绿区】响应敏感字段是否强制打码；默认 false。 */
  strictRedaction?: boolean;
}
export interface GenerationResult {
  commands: ApiCommand[];
  needsReview: ReviewItem[];
  redactedHeaders: string[];
}

// ============================================================================
// 13. SiteScan —— 放开分级后的「静态推导」通道（与 Q8 抓包采样完全隔离）
// ============================================================================
// JS bundle / HAR / OpenAPI / 声明式命令包都是静态或归档数据，MCP Server（Node 进程）
// 可直接读取：不经过浏览器、不 attach debugger、不依赖 tab 与登录会话。
// 因此 SiteScan 本身**不新增任何扩展消息**（第 14 节的 BundleCollect 是它的补充通道：
// 仅当 bundle 受登录态保护、Node 直读 401 时才走扩展侧取文本，扫描仍复用同一份纯函数）。
// 放开的是「看见接口」的能力；call_api_command 的全部执行侧安全闸门保持不变。

/** 单次扫描最多消费的数据源数（独立配额，不占 Q8 的 MAX_RESPONSE_SAMPLES=20）。 */
export const SITE_SCAN_MAX_SOURCES = 40;
/** 单源最大字节数（放开点：Q8 的 64KB → 2MB，以容纳前端 bundle）。 */
export const SITE_SCAN_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** 单次扫描总字节预算，超出即停止读取后续源。 */
export const SITE_SCAN_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** 单个内联文本最大字符数。 */
export const SITE_SCAN_MAX_TEXT_CHARS = 2 * 1024 * 1024;
/** 远端源 fetch 超时（毫秒）。 */
export const SITE_SCAN_FETCH_TIMEOUT_MS = 8000;
/** 静态推导最多产出的端点数（用于整站骨架，可大于抓包默认的 20）。 */
export const SITE_SCAN_MAX_ENDPOINTS = 200;
/** 远端源跟随重定向上限：0 = 不跟随，避免跨 host 跳转绕过同源校验。 */
export const SITE_SCAN_MAX_REDIRECTS = 0;

export const SITE_SCAN_KINDS = ["js", "har", "openapi", "commands"] as const;
export type SiteScanKind = typeof SITE_SCAN_KINDS[number];

/** 扫描输入：url 与 text 二选一；两者都给时优先 text（便于离线复现与单测）。 */
export interface SiteScanSource {
  kind: SiteScanKind;
  url?: string;
  text?: string;
}

/** 纯函数扫描结果：只含字段名 / 路径结构，绝不含样本值、header 值或凭据。 */
export interface SiteScanCandidate {
  method: HttpMethod;
  /** 结构用单花括号 {id}；渲染用双花括号 {{name}}，两者不可混用。 */
  pathTemplate: string;
  queryNames: string[];
  bodyNames: string[];
  origin: SiteScanKind;
  /**
   * 候选自带 host：来源是协议相对 URL（//host/path）时还原出的精确 hostname。
   * 缺省表示与扫描目标域名同源。
   */
  host?: string;
}

export interface SiteScanResult {
  candidates: SiteScanCandidate[];
  sourcesRead: number;
  bytesRead: number;
  warnings: string[];
}

/** 【放开·黄区】允许扫描内网 / 回环地址；默认 false，需调用方显式开启（SSRF 风险）。 */
export const SITE_SCAN_ALLOW_PRIVATE_HOSTS_DEFAULT = false;
/** 【放开·黄区】允许跨 hostname 的脚本源（CDN）；默认 false，需显式列 extraHosts。 */
export const SITE_SCAN_ALLOW_CROSS_HOST_DEFAULT = false;

/**
 * 【放开·绿区】静态推导默认放宽路径判定（`loosePaths` 的默认值）。
 * 放开前默认 false —— 现代站点（`/x/...`、`/pgc/...` 这类非标准前缀）一条都发现不了。
 * 改回 false 即可回到保守模式；这是配置化放开，**不删除任何判定代码**。
 */
export const SITE_SCAN_DEFAULT_LOOSE = true;

/**
 * 【放开·绿区】静态推导默认信任来源声明的 HTTP method（`trustSpec` 的默认值）。
 * 放开前默认 false —— 所有静态推导命令一律按 `write` 保守处理，GET 端点也要显式确认。
 * 改为 true 后按真实 method 判定 risk（GET/HEAD/OPTIONS → read，其余 → write）。
 * 改回 false 即可回到保守模式。
 */
export const SITE_SCAN_DEFAULT_TRUST_SPEC = true;

export const SITE_SCAN_REVIEW_REASON = "静态推导产物：接口来自前端代码 / 规格 / 归档流量，未经真实响应验证，参数与响应结构需人工复核";
export const SITE_SCAN_NO_SOURCE_WARNING = "未提供任何可读数据源，未生成命令；可传 sources（url 或 text）";
export const SITE_SCAN_PRIVATE_HOST_WARNING = "已按 allowPrivateHosts=false 跳过内网 / 回环地址的数据源";
export const SITE_SCAN_CROSS_HOST_WARNING = "已按同源策略跳过跨 hostname 的数据源；如需 CDN 脚本，必须同时传 allowCrossHost=true 并在 extraHosts 中列出该 hostname（两者是「总开关 + 精确白名单」的双重确认，缺一不可）";
export const SITE_SCAN_SOURCE_FAILED_WARNING = "部分数据源读取失败或超过配额，已跳过";
export const SITE_SCAN_CONSERVATIVE_RISK_WARNING = "静态推导命令默认全部按 write 保守处理；可传 trustSpec=false 保持该保守模式，trustSpec=true 时按来源声明的 method 判定";
/** 静态推导还原出跨 host 端点（协议相对 URL）时的说明；只给条数，不回显任何 host。 */
export const SITE_SCAN_CROSS_HOST_COMMAND_WARNING = "部分静态推导端点来自协议相对 URL，其 host 与扫描目标域名不同；命令已按各自 host 归档，执行时仍受扩展侧域名白名单约束";

// ============================================================================
// 14. BundleCollect —— 扩展侧「带登录态补采 JS bundle」（scan_site 的补充通道）
// ============================================================================
// 动机：登录态站点的 bundle 常由服务端按会话鉴权，Node 直读会 401；而浏览器里的
// 页面上下文天然持有该会话。因此把「取文本」这一步下沉到扩展侧，取到的文本仍回传
// MCP 侧交给同一个 scanSources() 解析 —— **扫描逻辑只有一份**，不复制。
//
// 硬约束：
//  1. 只取文本，不取 header / cookie / 凭据；请求固定 GET + credentials:'include'，
//     不给调用方任何注入 method / header / body 的入口（见 BUNDLE_COLLECT_FORBIDDEN_KEYS）。
//  2. 原文只在「扩展 → 消息 → 编排层局部变量」中流转，绝不落盘 / 进日志 / 进缓存 /
//     进报告（沿用 Q8 样本纪律）。
//  3. 目标 URL 仅 http(s)、无 userinfo、hostname 必须精确命中 domain 或显式 extraHosts；
//     与 api-command-site-scan.ts 的 checkScanUrl() 语义一致但**执行主体不同**
//     （扩展侧校验是真正的边界，MCP 侧回包还要再校验一次）。

/** 单次补采最多请求的 URL 数（低于 SITE_SCAN_MAX_SOURCES，避免一次消息过重）。 */
export const BUNDLE_COLLECT_MAX_SOURCES = 10;
/** 单源文本上限（与 SITE_SCAN_MAX_SOURCE_BYTES 对齐）。 */
export const BUNDLE_COLLECT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** 单次补采总字节预算，超预算即停止采集后续 URL。 */
export const BUNDLE_COLLECT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** 单个 URL 的采集超时（毫秒）。 */
export const BUNDLE_COLLECT_TIMEOUT_MS = 8000;
/**
 * 整条命令的墙钟预算（毫秒）。必须显著小于 bridge 的 30s 通用超时：
 * 10 个 URL × 三层 fallback 的最坏耗时远超单 URL 超时，必须有全局闸门。
 */
export const BUNDLE_COLLECT_WALL_BUDGET_MS = 20000;
/** 未显式指定时的默认采集条数（discover 自动发现时尤其需要克制）。 */
export const BUNDLE_COLLECT_DEFAULT_SOURCES = 6;

/** 采集顺序（与扩展侧实现顺序逐字一致）：页面上下文 → Service Worker → 浏览器缓存。 */
export const BUNDLE_COLLECT_VIAS = ["page", "worker", "cache"] as const;
export type BundleCollectVia = typeof BUNDLE_COLLECT_VIAS[number];

/** options 白名单：任何未知键一律丢弃（含 headers / cookies / method / body）。 */
export const BUNDLE_COLLECT_ALLOWED_KEYS = [
  "urls", "discover", "maxSources", "maxBytes", "timeoutMs", "useBrowserCache", "hosts",
] as const;
export const BUNDLE_COLLECT_FORBIDDEN_KEYS = [
  "headers", "cookies", "credentials", "method", "body", "postData", "confirm", "tabId", "overrides",
] as const;

export const BUNDLE_COLLECT_EMPTY_WARNING = "扩展侧未发现可补采的 JS bundle（页面可能尚未加载脚本或尚未登录）";
/** discoverBundles 未显式传 tabId 且结果为空时的补充提示（多半是扫到了 about:blank）。 */
export const BUNDLE_COLLECT_TAB_HINT_WARNING = "自动发现依赖「当前标签页」：未传 tabId 时扩展取的是活动标签页，navigate 会新建标签页，活动页可能是 about:blank。请把 navigate 返回的 tabId 显式传入 scan_site";
export const BUNDLE_COLLECT_FAILED_WARNING = "部分 bundle 在页面上下文 / Service Worker / 浏览器缓存三层均未取到，已跳过并使用直读兜底";
export const BUNDLE_COLLECT_TRUNCATED_WARNING = "补采内容超过单源或总量配额，已截断或跳过";
export const BUNDLE_COLLECT_NO_EXTENSION_WARNING = "扩展未连接或未响应，登录态补采已跳过；本次仅用 Node 直读（受登录态保护的 bundle 会失败）";

/** 扩展回包的单个采集结果：只含 url / 文本 / 命中层级 / 字节数。 */
export interface BundleCollectSource {
  url: string;
  ok: boolean;
  text: string;
  via: BundleCollectVia;
  bytes: number;
}

export interface BundleCollectResult {
  sources: BundleCollectSource[];
  requested: number;
  collected: number;
  discovered: number;
  warnings: string[];
}
