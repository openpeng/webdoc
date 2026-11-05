// api-command-helpers.js — 扩展侧「API 命令集」共享常量与安全 helper。
//
// 引入方式：background.js 顶部 `importScripts('api-command-helpers.js')`。
// manifest.json 未声明 "type":"module"（classic service worker），故 importScripts 原生可用，
// 本文件中的顶层 const / function 与 background.js 共享同一全局词法环境。
//
// ⚠️ 【两端共享值与字段形状，不共享代码】本文件所有标注「同步」的常量必须与
//   mcp-server/src/api-command-types.ts 逐字一致；不得 import 任何 MCP 侧模块。
//   两端只共享常量值 + 回包字段形状，不共享实现。
//
// 本文件只放常量、正则与纯 helper；不持有任何状态、不注册任何监听器。
// 分析会话状态（apiAnalysisSessions）与 CDP 监听器一律在 background.js 中。

// ============================================================================
// 1. 版本、文件与时间（同步 api-command-types.ts §1）
// ============================================================================

const SCHEMA_VERSION = 1;
const SUPPORTED_SCHEMA_VERSION = 1;
const CACHE_VERSION = 1;
const CACHE_FILE_NAME = 'api-commands.json';
const GENERATED_BY = '1.1.1';
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const REDACTED_VALUE = '[REDACTED]';
const API_LOG_PREFIX = '[api-command]';

// ============================================================================
// 2. 阈值常量（同步 §2）
// ============================================================================

const MAX_CONSECUTIVE_FAILURES = 4;
const MAX_ENDPOINTS_DEFAULT = 20;
const MAX_RESPONSE_SAMPLES = 20;
const MAX_RESPONSE_SAMPLE_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 6;
const MAX_ARRAY_SAMPLES = 5;
const MAX_BODY_CHARS_DEFAULT = 50000;
const MAX_BODY_CHARS_MIN = 1000;
const MAX_BODY_CHARS_MAX = 500000;
const STALE_AFTER_DAYS = 30;
const MAX_CONCURRENT_ANALYSES = 3;
const API_EXEC_TIMEOUT_MS = 25000;
const API_EXEC_TIMEOUT_MIN_MS = 100;
const API_EXEC_TIMEOUT_DEFAULT_MS = 10000;
const MAX_RESPONSE_FIELDS = 60;
const MAX_SCHEMA_FIELDS = 200;
const MAX_SAFE_LITERAL_LENGTH = 32;
const MAX_SAFE_INTEGER_ABS = 100000;
const MAX_NOTE_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const MAX_PATH_TEMPLATE_LENGTH = 512;
const MAX_HEADER_NAME_LENGTH = 128;

// BundleCollect：扩展侧带登录态补采 JS bundle（同步 §14）
const BUNDLE_COLLECT_MAX_SOURCES = 10;
const BUNDLE_COLLECT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const BUNDLE_COLLECT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const BUNDLE_COLLECT_TIMEOUT_MS = 8000;
const BUNDLE_COLLECT_WALL_BUDGET_MS = 20000;
const BUNDLE_COLLECT_DEFAULT_SOURCES = 6;
const BUNDLE_COLLECT_VIAS = ['page', 'worker', 'cache'];
const BUNDLE_COLLECT_EMPTY_WARNING = '扩展侧未发现可补采的 JS bundle（页面可能尚未加载脚本或尚未登录）';
const BUNDLE_COLLECT_FAILED_WARNING = '部分 bundle 在页面上下文 / Service Worker / 浏览器缓存三层均未取到，已跳过并使用直读兜底';
const BUNDLE_COLLECT_TRUNCATED_WARNING = '补采内容超过单源或总量配额，已截断或跳过';

// ============================================================================
// 3. 正则与路径归一规则（同步 §3，逐字复制）
// ============================================================================

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PARAM_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
const PARAM_PLACEHOLDER_RE = /\{\{([a-z0-9_]{1,64})\}\}/g;
const PLACEHOLDER_ONLY_RE = /^\{\{[a-z0-9_]{1,64}\}\}$/;
const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{10}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const RESPONSE_FIELD_PATTERN = /^[a-zA-Z0-9_\-]+(?:\[\])?(?:\.[a-zA-Z0-9_\-]+(?:\[\])?)*$/;
const PATH_TEMPLATE_PATTERN = /^\/[^\s"'<>\\?#:*]{0,511}$/;
const SAFE_LITERAL_STRING_RE = /^[a-z0-9_-]{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT_RE = /^\d+$/;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;
const HIGH_ENTROPY_SEGMENT_RE = /^(?=.*[0-9])(?=.*[a-z])[a-z0-9_-]{16,}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?\d[\d\s()-]{6,20}$/;
const VERSION_PATH_SEGMENT_RE = /^v\d+(?:\.\d+)?$/i;
const API_SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|proxy-authorization)$|token|secret|key|csrf|xsrf|auth/i;

// ============================================================================
// 4. 枚举（同步 §4）
// ============================================================================

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const RISKS = ['read', 'write'];
const PARAM_LOCATIONS = ['path', 'query', 'body'];
const PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
const ANALYSIS_MODES = ['full', 'merge'];

// ============================================================================
// 5. 消息类型常量（同步 §5，两端逐字一致，最关键）
// ============================================================================

const MSG = {
  ANALYSIS_START: 'apiAnalysisStart',
  ANALYSIS_STOP: 'apiAnalysisStop',
  COMMAND_EXECUTE: 'apiCommandExecute',
  BUNDLE_COLLECT: 'apiBundleCollect'
};

const MSG_RESULT = {
  ANALYSIS_START: 'apiAnalysisStartResult',
  ANALYSIS_STOP: 'apiAnalysisStopResult',
  COMMAND_EXECUTE: 'apiCommandExecuteResult',
  BUNDLE_COLLECT: 'apiBundleCollectResult',
  ERROR: 'error'
};

/**
 * 加入 TAB_SCOPED_COMMANDS 的消息：三者都需要「当前会话组内的具体 tab」。
 * apiCommandExecute 不加入（免开网页）；bundle 补采必须借页面上下文取登录态。
 */
const TAB_SCOPED_API_MESSAGES = [MSG.ANALYSIS_START, MSG.ANALYSIS_STOP, MSG.BUNDLE_COLLECT];

// ============================================================================
// 6. 错误码（同步 §6，全量 27 项，顺序与取值逐字一致）
// ============================================================================

const API_ERROR_CODES = [
  'NO_CACHE', 'COMMAND_NOT_FOUND', 'COMMAND_DISABLED', 'COMMAND_DEPRECATED',
  'MISSING_PARAMS', 'INVALID_PARAMS', 'UNSAFE_PATH_PARAM', 'HOST_MISMATCH_AFTER_RENDER',
  'CONFIRMATION_REQUIRED', 'READ_ONLY_BLOCKED', 'EMERGENCY_STOPPED',
  'DOMAIN_NOT_ALLOWED', 'HOST_MISMATCH', 'INVALID_URL',
  'REDIRECT_BLOCKED', 'AUTH_REQUIRED', 'DRIFTED', 'DISABLED_AFTER_FAILURES',
  'ANALYSIS_IN_PROGRESS', 'NO_ANALYSIS_SESSION', 'NO_EXTENSION',
  'EXTENSION_TIMEOUT', 'NETWORK_ERROR', 'HTTP_ERROR',
  'MAX_ENDPOINTS_EXCEEDED', 'SCHEMA_VERSION_UNSUPPORTED', 'WRITE_FAILED'
];

/** 错误码 → 固定中文文案（同步 §6）。回包与日志只用固定文案，绝不回显外部原文。 */
const ERROR_SAFE_MESSAGES = {
  NO_CACHE: '该域名尚无命令集，请先执行页面分析',
  COMMAND_NOT_FOUND: '未找到指定命令',
  COMMAND_DISABLED: '命令已被禁用',
  COMMAND_DEPRECATED: '命令已被标记为弃用',
  MISSING_PARAMS: '缺少必填参数，未发送任何请求',
  INVALID_PARAMS: '参数类型或取值不符合约束，未发送任何请求',
  UNSAFE_PATH_PARAM: '路径参数包含非法字符，未发送任何请求',
  HOST_MISMATCH_AFTER_RENDER: '渲染后的目标主机与命令所属域名不一致，未发送任何请求',
  CONFIRMATION_REQUIRED: '写命令需要显式确认，未发送任何请求',
  READ_ONLY_BLOCKED: '本地只读模式已拒绝写命令',
  EMERGENCY_STOPPED: '紧急停止已生效，拒绝全部命令',
  DOMAIN_NOT_ALLOWED: '目标地址不在域名白名单内',
  HOST_MISMATCH: '目标主机与命令所属域名不一致',
  INVALID_URL: '目标地址协议或格式非法',
  REDIRECT_BLOCKED: '检测到重定向，按 fail-closed 策略阻断，未跟随',
  AUTH_REQUIRED: '登录态可能已失效，请人工重新登录后重试',
  DRIFTED: '响应结构发生漂移，建议重新分析',
  DISABLED_AFTER_FAILURES: '连续失败达到上限，命令已自动禁用',
  ANALYSIS_IN_PROGRESS: '该标签页已有进行中的分析会话',
  NO_ANALYSIS_SESSION: '未找到对应的分析会话',
  NO_EXTENSION: '浏览器扩展离线或不可用',
  EXTENSION_TIMEOUT: '扩展响应超时',
  NETWORK_ERROR: '网络请求失败',
  HTTP_ERROR: '目标接口返回错误状态',
  MAX_ENDPOINTS_EXCEEDED: '端点数超过上限，已按观测频次截断',
  SCHEMA_VERSION_UNSUPPORTED: '命令 schema 版本高于当前支持版本，已跳过',
  WRITE_FAILED: '缓存写入失败（仅告警，不阻断调用链路）'
};

// ============================================================================
// 7. 白名单字段清单（同步 §7，三处白名单重建）
// ============================================================================

const COMMAND_ALLOWED_KEYS = [
  'commandId', 'name', 'domain', 'risk', 'confidence', 'schemaVersion',
  'manuallyEdited', 'deprecated', 'note', 'request', 'params', 'responseFields',
  'responseSchema', 'redactedHeaderNames', 'source', 'health',
  'analyzedAt', 'lastVerifiedAt', 'createdAt', 'updatedAt', 'steps'
];
const COMMAND_FORBIDDEN_KEYS = [
  'computed', 'script', 'eval', 'function', 'headers', 'cookie', 'authorization',
  'token', 'secret', 'csrf', 'prototype', 'constructor', '__proto__'
];
const REQUEST_TEMPLATE_ALLOWED_KEYS = ['method', 'urlTemplate', 'pathTemplate', 'bodyTemplate', 'queryTemplate', 'headers'];
const API_PARAM_ALLOWED_KEYS = ['name', 'location', 'type', 'required', 'description', 'enumCount', 'allowedValues', 'constant', 'defaultValue'];
const SCHEMA_FIELD_ALLOWED_KEYS = ['path', 'type', 'array', 'isPagination', 'redacted'];
const RESPONSE_SCHEMA_ALLOWED_KEYS = ['fields', 'depthLimited', 'sampleCount'];
const SOURCE_ALLOWED_KEYS = ['analysisId', 'analyzedAt', 'generatedBy', 'origin', 'crossHost'];
const HEALTH_ALLOWED_KEYS = [
  'hits', 'misses', 'consecutiveFailures', 'disabled', 'totalDurationMs',
  'lastSuccessAt', 'lastFailureAt', 'lastError', 'drifted', 'authRequired',
  'needsMigration', 'stale'
];
const CACHE_FILE_ALLOWED_KEYS = ['version', 'generatedBy', 'updatedAt', 'domains'];
const DOMAIN_BUCKET_ALLOWED_KEYS = ['host', 'updatedAt', 'commands'];

/** (b) 扩展侧 msg.options 白名单 —— 逐字同步。 */
const START_OPTIONS_ALLOWED_KEYS = ['analysisId', 'filter', 'includeStaticAssets', 'maxEndpoints', 'captureResponseBody'];
const FILTER_ALLOWED_KEYS = ['urlContains', 'mimeType'];
const STOP_OPTIONS_ALLOWED_KEYS = ['analysisId'];
const EXECUTE_OPTIONS_ALLOWED_KEYS = ['url', 'method', 'hostname', 'risk', 'body', 'maxBodyChars', 'timeoutMs', 'headers'];
/** 客户端注入这些字段一律丢弃（AC-22 关键）—— 逐字同步。 */
const EXECUTE_OPTIONS_FORBIDDEN_KEYS = ['confirm', 'overrides', 'tabId'];
/** bundle 补采 options 白名单：只允许「取哪些 URL / 取多少 / 走不走缓存」，不含任何请求构造入口。 */
const BUNDLE_COLLECT_ALLOWED_KEYS = ['urls', 'discover', 'maxSources', 'maxBytes', 'timeoutMs', 'useBrowserCache', 'hosts'];
const BUNDLE_COLLECT_FORBIDDEN_KEYS = ['headers', 'cookies', 'credentials', 'method', 'body', 'postData', 'confirm', 'tabId', 'overrides'];

/**
 * 只读模式下的安全方法白名单：不在表内的一律按写操作处理（fail-closed）—— 逐字同步。
 * 只读门按 method 派生，不采信客户端上报的 risk（risk 是客户端自述字段）。
 */
const READ_ONLY_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * 只读判定：按 HTTP method 派生，**不采信客户端上报的 risk**（AC-12）。
 * method 缺失 / 非法一律按写操作处理（fail-closed）。
 */
function isReadOnlySafeMethod(method) {
  return READ_ONLY_SAFE_METHODS.indexOf(String(method || '').toUpperCase()) >= 0;
}

/** (c) 请求 header 最低保证集：这两个头由代码无条件补上，不依赖调用方。 */
const API_COMMAND_ALLOWED_HEADERS = ['accept', 'content-type'];

/** 【放开·绿区】请求头黑名单：命中即静默剔除 —— 逐字同步。 */
const API_COMMAND_FORBIDDEN_HEADERS = ['cookie', 'authorization', 'proxy-authorization', 'set-cookie'];
/** 请求头字段名合法性（RFC 7230 token）—— 逐字同步。 */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** 请求头值长度上限 —— 逐字同步。 */
const MAX_HEADER_VALUE_LENGTH = 512;

/**
 * 【放开·绿区】请求头过滤：保留全部非凭据头，只剔除凭据黑名单与非法头。
 * 扩展侧是真正的边界，因此这里必须独立再过滤一次（MCP 侧已滤过，但消息不可全信）。
 */
function sanitizeRequestHeaders(headers) {
  const out = {};
  if (!apiIsPlainObject(headers)) return out;
  for (const rawName of Object.keys(headers)) {
    const name = String(rawName).trim();
    if (!name || !HEADER_NAME_PATTERN.test(name)) continue;
    if (API_COMMAND_FORBIDDEN_HEADERS.indexOf(name.toLowerCase()) >= 0) continue;
    const rawValue = headers[rawName];
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    const value = String(rawValue);
    if (!value || value.length > MAX_HEADER_VALUE_LENGTH) continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/** (d) 响应敏感字段黑名单。 */
const RESPONSE_SENSITIVE_FIELDS = [
  'password', 'token', 'secret', 'authorization', 'cookie', 'session', 'csrf', 'xsrf',
  'phone', 'email', 'id_card', 'access_key', 'api_key', 'private_key', 'credential'
];

const PARAM_RESERVED_NAMES = [
  'confirm', 'domain', 'tabid', 'action', 'fields', 'maxbodychars', 'timeoutms', 'mode',
  'overwritemanual', 'includestaticassets', 'captureresponsebody', 'maxendpoints',
  'sessionid', 'requestid', 'analysisid', 'risk', 'commandid', 'dryrun', 'options'
];
const REQUEST_PARAM_NAME_DENYLIST = [...RESPONSE_SENSITIVE_FIELDS, ...PARAM_RESERVED_NAMES];

// ============================================================================
// 8. 过滤 / 采样 / 命名辅助清单（同步 §8）
// ============================================================================

const STATIC_RESOURCE_TYPES = ['document', 'stylesheet', 'script', 'image', 'font', 'media'];
const STATIC_ASSET_EXTENSIONS = [
  '.js', '.mjs', '.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.webm', '.pdf', '.zip'
];
const TELEMETRY_PATH_KEYWORDS = [
  '/log', '/track', '/beacon', '/analytics', '/metrics', '/sentry', '/collect',
  '/telemetry', '/pixel', '/rum'
];
/** Q8 采样候选 resourceType。 */
const SAMPLE_CANDIDATE_RESOURCE_TYPES = ['xhr', 'fetch'];
/** Q8 采样候选 mimeType 关键字，且 status 必须 2xx。 */
const SAMPLE_MIME_KEYWORDS = ['json', 'text/'];
const GENERIC_PATH_SEGMENTS = ['api', 'rest', 'v1', 'v2', 'v3', 'service', 'services'];
const PAGINATION_FIELD_NAMES = [
  'total', 'count', 'page', 'size', 'hasmore', 'has_more', 'next', 'nextpage', 'pages',
  'limit', 'offset', 'pageno', 'pagesize', 'totalcount', 'total_count'
];
const FILTER_PARAM_NAME_HINTS = [
  'page', 'size', 'keyword', 'query', 'filter', 'search', 'sort', 'limit', 'offset',
  'order', 'q', 'from', 'to'
];

// ============================================================================
// 9. 日志脱敏规则（同步 §9）
// ============================================================================

const LOG_STRIP_KEYS = [
  'text', 'script', 'body', 'params', 'samples', 'records', 'postData', 'queryParams', 'headers'
];
const API_LOG_ALLOWED_KEYS = [
  'action', 'commandId', 'method', 'hostname', 'risk', 'status', 'durationMs', 'success'
];

// ============================================================================
// 10. 固定文案（同步 §10）
// ============================================================================

const POST_LIST_QUERY_REVIEW_REASON = 'POST 请求体为筛选与分页字段、响应为列表，疑似只读查询；人工确认前按 write 处理';
const NAME_CONFLICT_REVIEW_REASON = '命令名冲突，已追加路径短哈希后缀，请人工重命名';
const MISSING_SAMPLE_REVIEW_REASON = '缺少响应体样本，responseSchema 为空，建议开启 captureResponseBody 重新分析';
const LOW_CONFIDENCE_REVIEW_REASON = '置信度低于 0.6，请人工复核参数与响应结构';
const ANALYZE_CURRENT_REVIEW_REASON = 'analyze_current 兼容入口不做响应体采样，产物强制需人工复核且 responseSchema 为空';
const NON_JSON_BODY_REVIEW_REASON = '请求体不是 JSON 对象，未生成 bodyTemplate，请人工复核';
const UNSAFE_CONSTANT_REVIEW_REASON = '检测到不安全常量或敏感字段名，已转为必填参数或丢弃，请人工复核';
const STALE_MANUAL_WARNING = '人工修正命令未在本次分析中观测到，已保留并标记 stale；如需删除请设置 overwriteManual=true';
const NO_CACHE_LIST_WARNING = '该域名尚无命令集，请调用 analyze_page_apis 进行页面分析';
const NEEDS_REVIEW_DESCRIPTION_PREFIX = '[需人工复核] ';

// ============================================================================
// 11. 纯 helper（两端不共享代码，只共享上面常量的值与字段形状）
// ============================================================================

function apiIsPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function apiClampInt(value, min, max, fallback) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** 只保留白名单键，构造全新对象；任何未知键 / 注入字段一律不进入结果。 */
function apiPickWhitelist(raw, allowedKeys) {
  const out = {};
  if (!apiIsPlainObject(raw)) return out;
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
  }
  return out;
}

/**
 * 组装「机器可读错误码 + 固定安全文案」的 message。
 * 扩展侧回包统一 `success:false, error: '<CODE>|<safe message>'`；
 * MCP 侧 ApiCommandService.classifyExtensionError 解析前缀得到结构化错误码。
 * 绝不拼接真实 URL / body / header 值（AC-20）。
 */
function formatApiError(code, extraToken) {
  const base = ERROR_SAFE_MESSAGES[code] || '未知错误';
  const token = typeof extraToken === 'string' && extraToken.trim()
    ? ` (${extraToken.trim().slice(0, 80)})`
    : '';
  return `${code}|${base}${token}`;
}

/**
 * 目标 URL 安全断言（设计 1.3.5 落点 #4）：
 *  - 协议必须 http(s)；
 *  - Q13：渲染后的 hostname 与命令所属 hostname **精确相等**（不合并 www. / 不回退父域）；
 *  - 域名白名单沿用 isUrlAllowed 的「host === domain || host.endsWith('.'+domain)」语义。
 * 校验的是 msg.options.url（目标 URL），而非当前标签 URL（AC-23/24）。
 * 抛出的 Error.message 已带错误码前缀。
 */
function assertApiTargetUrl(url, hostname, allowedDomains) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error(formatApiError('INVALID_URL'));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(formatApiError('INVALID_URL'));
  }
  const host = parsed.hostname.toLowerCase();
  const expected = String(hostname || '').trim().toLowerCase();
  if (!expected || host !== expected) {
    throw new Error(formatApiError('HOST_MISMATCH'));
  }
  const domains = Array.isArray(allowedDomains) ? allowedDomains : [];
  if (domains.length > 0) {
    const ok = domains.some((domain) => {
      const candidate = String(domain || '').trim().toLowerCase();
      return !!candidate && (host === candidate || host.endsWith(`.${candidate}`));
    });
    if (!ok) throw new Error(formatApiError('DOMAIN_NOT_ALLOWED'));
  }
}

/** apiAnalysisStart 的 msg.options 白名单重建（START_OPTIONS_ALLOWED_KEYS）。 */
function rebuildStartOptions(raw) {
  const picked = apiPickWhitelist(raw, START_OPTIONS_ALLOWED_KEYS);
  const out = {
    analysisId: typeof picked.analysisId === 'string' ? picked.analysisId.slice(0, 128) : '',
    includeStaticAssets: picked.includeStaticAssets === true,
    maxEndpoints: apiClampInt(picked.maxEndpoints, 1, 200, MAX_ENDPOINTS_DEFAULT),
    captureResponseBody: picked.captureResponseBody === true
  };
  if (apiIsPlainObject(picked.filter)) {
    const filter = apiPickWhitelist(picked.filter, FILTER_ALLOWED_KEYS);
    const clean = {};
    if (typeof filter.urlContains === 'string' && filter.urlContains.trim()) {
      clean.urlContains = filter.urlContains.trim().slice(0, 200);
    }
    if (typeof filter.mimeType === 'string' && filter.mimeType.trim()) {
      clean.mimeType = filter.mimeType.trim().slice(0, 100);
    }
    if (Object.keys(clean).length > 0) out.filter = clean;
  }
  return out;
}

/** apiAnalysisStop 的 msg.options 白名单重建（STOP_OPTIONS_ALLOWED_KEYS）。 */
function rebuildStopOptions(raw) {
  const picked = apiPickWhitelist(raw, STOP_OPTIONS_ALLOWED_KEYS);
  return {
    analysisId: typeof picked.analysisId === 'string' ? picked.analysisId.slice(0, 128) : ''
  };
}

/**
 * 判断一个 URL 能否被 bundle 补采读取（纯函数，扩展侧真正的安全边界之一）。
 * 与 api-command-site-scan.ts 的 checkScanUrl() 语义一致：
 *  - 仅 http(s)，URL 内不得含 userinfo（避免把凭据写进目标地址）；
 *  - hostname 必须**精确**命中 hosts 之一（小写、去尾点，不做后缀匹配）；
 *  - hosts 为空一律拒绝（fail-closed：没有目标域就不知道能取什么）。
 * 返回固定 reason 枚举，绝不回显原始 URL 或查询串。
 */
function apiCheckBundleUrl(rawUrl, hosts) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, host: '', reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, host: '', reason: 'invalid' };
  }
  if (parsed.username || parsed.password) return { ok: false, host: '', reason: 'invalid' };
  const host = apiNormalizeHostname(parsed.hostname);
  if (!host) return { ok: false, host: '', reason: 'invalid' };
  const allowed = (Array.isArray(hosts) ? hosts : [])
    .map((item) => apiNormalizeHostname(String(item || '')))
    .filter(Boolean);
  if (!allowed.length || !allowed.includes(host)) return { ok: false, host, reason: 'host' };
  return { ok: true, host, reason: '', url: parsed.toString() };
}

/** apiBundleCollect 的 msg.options 白名单重建（BUNDLE_COLLECT_ALLOWED_KEYS）。 */
function rebuildBundleCollectOptions(raw) {
  const picked = apiPickWhitelist(raw, BUNDLE_COLLECT_ALLOWED_KEYS);
  const urls = [];
  if (Array.isArray(picked.urls)) {
    for (const item of picked.urls) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim().slice(0, 2048);
      if (!trimmed || urls.includes(trimmed)) continue;
      urls.push(trimmed);
      if (urls.length >= BUNDLE_COLLECT_MAX_SOURCES) break;
    }
  }
  const hosts = [];
  if (Array.isArray(picked.hosts)) {
    for (const item of picked.hosts) {
      if (typeof item !== 'string' && typeof item !== 'number') continue;
      const host = apiNormalizeHostname(String(item));
      if (host && !hosts.includes(host)) hosts.push(host);
      if (hosts.length >= 20) break;
    }
  }
  return {
    urls,
    hosts,
    discover: picked.discover === true,
    maxSources: apiClampInt(picked.maxSources, 1, BUNDLE_COLLECT_MAX_SOURCES, BUNDLE_COLLECT_DEFAULT_SOURCES),
    maxBytes: apiClampInt(picked.maxBytes, 1024, BUNDLE_COLLECT_MAX_SOURCE_BYTES, BUNDLE_COLLECT_MAX_SOURCE_BYTES),
    timeoutMs: apiClampInt(picked.timeoutMs, 100, 30000, BUNDLE_COLLECT_TIMEOUT_MS),
    // 默认开启浏览器缓存层（只在页面上下文与 SW 都失败后才真正用到）
    useBrowserCache: picked.useBrowserCache !== false
  };
}

/**
 * apiCommandExecute 的 msg.options 白名单重建（AC-22 关键）。
 * 从零构造对象，只拷 EXECUTE_OPTIONS_ALLOWED_KEYS；因此
 * `confirm` / `overrides` / `tabId` 及任意注入字段**一律被丢弃**。
 * 【放开·绿区】`headers` 现在在白名单内，但只保留**非凭据头**（凭据黑名单静默剔除）。
 * 扩展侧从不读取 `confirm` —— 它不是安全边界，真正边界是 chrome.storage.local。
 */
function rebuildExecuteOptions(raw) {
  const picked = apiPickWhitelist(raw, EXECUTE_OPTIONS_ALLOWED_KEYS);
  // 显式声明禁用键存在即忽略（防御性；白名单重建本身已保证不进入结果）。
  for (const forbidden of EXECUTE_OPTIONS_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(picked, forbidden)) delete picked[forbidden];
  }
  const out = {
    url: typeof picked.url === 'string' ? picked.url : '',
    method: typeof picked.method === 'string' ? String(picked.method).toUpperCase() : '',
    hostname: typeof picked.hostname === 'string' ? picked.hostname.trim().toLowerCase() : '',
    risk: picked.risk === 'write' ? 'write' : 'read',
    body: typeof picked.body === 'string' ? picked.body : null,
    headers: sanitizeRequestHeaders(picked.headers),
    maxBodyChars: apiClampInt(picked.maxBodyChars, MAX_BODY_CHARS_MIN, MAX_BODY_CHARS_MAX, MAX_BODY_CHARS_DEFAULT),
    timeoutMs: apiClampInt(picked.timeoutMs, API_EXEC_TIMEOUT_MIN_MS, API_EXEC_TIMEOUT_MS, API_EXEC_TIMEOUT_DEFAULT_MS)
  };
  if (!HTTP_METHODS.includes(out.method)) out.method = '';
  return out;
}

/**
 * Q8 采样候选判定（设计 7.4）：仅 xhr/fetch + mimeType 含 json 或 text/ + status 2xx。
 * detail 形如 { type, mimeType, status }；只看元数据，绝不读取响应体内容。
 */
function isSampleCandidate(detail) {
  if (!apiIsPlainObject(detail)) return false;
  const type = String(detail.type || '').toLowerCase();
  if (!SAMPLE_CANDIDATE_RESOURCE_TYPES.includes(type)) return false;
  const mime = String(detail.mimeType || '').toLowerCase();
  if (!SAMPLE_MIME_KEYWORDS.some((keyword) => mime.includes(keyword))) return false;
  const status = Number(detail.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

/**
 * 解码 CDP Network.getResponseBody 的结果；单条超过 MAX_RESPONSE_SAMPLE_BYTES 直接丢弃
 * （不截断、不猜测）。base64Encoded 时按**解码后字节数**判断。
 * 返回 bodyText 或 null；样本值只在调用方内存中流转。
 */
function decodeCdpResponseBody(result) {
  if (!apiIsPlainObject(result)) return null;
  const raw = typeof result.body === 'string' ? result.body : '';
  if (!raw) return null;
  if (result.base64Encoded === true) {
    let binary;
    try { binary = atob(raw); } catch { return null; }
    if (binary.length > MAX_RESPONSE_SAMPLE_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return null; }
  }
  if (raw.length > MAX_RESPONSE_SAMPLE_BYTES) return null;
  return raw;
}

/** 新命令日志脱敏：只保留 API_LOG_ALLOWED_KEYS，绝不记 url / body / 响应体 / header 值。 */
function safeLogForApiExecute(entry) {
  const out = {};
  if (!apiIsPlainObject(entry)) return out;
  for (const key of API_LOG_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) out[key] = entry[key];
  }
  return out;
}

/** 只保留敏感 header **字段名**（小写去重排序），值绝不进入任何输出（AC-20）。 */
function apiRedactHeaderNames(names) {
  const out = new Set();
  if (!Array.isArray(names)) return [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().toLowerCase().slice(0, MAX_HEADER_NAME_LENGTH);
    if (name && API_SENSITIVE_HEADER_RE.test(name)) out.add(name);
  }
  return [...out].sort();
}

/** 精确 hostname：小写、去协议 / userinfo / 端口 / 路径（Q13）。 */
function apiNormalizeHostname(input) {
  if (typeof input !== 'string') return '';
  let value = input.trim().toLowerCase();
  if (!value) return '';
  const schemeIndex = value.indexOf('://');
  if (schemeIndex >= 0) value = value.slice(schemeIndex + 3);
  for (const delimiter of ['/', '?', '#']) {
    const index = value.indexOf(delimiter);
    if (index >= 0) value = value.slice(0, index);
  }
  const atIndex = value.lastIndexOf('@');
  if (atIndex >= 0) value = value.slice(atIndex + 1);
  const colon = value.lastIndexOf(':');
  if (colon >= 0 && /^\d+$/.test(value.slice(colon + 1))) value = value.slice(0, colon);
  return value.replace(/\.+$/, '');
}
