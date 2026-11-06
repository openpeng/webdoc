/**
 * MCP 工具入参 → 服务层参数的**纯函数**归一化层。
 *
 * ## 为什么需要这一层
 *
 * 传输层（server.ts）直接把 tool args 塞给编排层（api-command-service.ts）时，
 * 曾经用 `args.X === true` 归一化可选布尔开关。这会把「调用方**没传**该参数」
 * 和「调用方**显式传了 false**」压成同一个值 —— 而编排层恰恰用 `undefined`
 * 来表达「走默认值」。
 *
 * 实测后果（T12，deploy_to_test 阶段经真实 MCP 调用发现）：
 *   - `loosePaths` 编排层默认 `SITE_SCAN_DEFAULT_LOOSE = true`（现代站点 /x/... 路径
 *     只有放宽模式才认），被压成 false 后 scan_site 在真实站点上**一条端点都产不出**；
 *   - `trustSpec` 编排层默认 `SITE_SCAN_DEFAULT_TRUST_SPEC = true`（按来源声明的
 *     method 判 risk），被压成 false 后所有静态推导命令一律按 write 保守处理；
 *   - `discoverBundles` 编排层默认是「有 tabId 且没有远端源时自动发现」，被压成
 *     false 后扩展侧 bundle 自动发现永不触发（Node 侧 HTML 正则只看到 1/3 bundle）。
 *
 * 三者的文档默认值都因此**在 MCP 工具层不可达**，配置化放开形同虚设。
 *
 * ## 纪律
 *
 * - 只有**编排层定义了「undefined → 默认值」语义**的开关才允许透传 undefined；
 *   其余布尔一律收敛成确定的 true/false（默认 false 的开关）。
 * - 纯函数：无 IO、无 Date、不读环境变量，可直接 `node --test` 直测。
 * - 显式传 false 依然是 false —— 放开是默认值，不是强制值，回退路径完好。
 */

import type { AnalysisMode, SiteScanSource } from "./api-command-types.js";

/** 编排层定义了「undefined → 默认值」语义的可选布尔开关。 */
const TRI_STATE_BOOLEANS = [
  "trustSpec",
  "loosePaths",
  "discoverBundles",
  "bundleUseBrowserCache",
  "provenance",
] as const;

type TriStateBoolean = (typeof TRI_STATE_BOOLEANS)[number];

/** 编排层默认即 false 的布尔开关：undefined 直接收敛成 false。 */
const DEFAULT_FALSE_BOOLEANS = [
  "includeStaticAssets",
  "captureResponseBody",
  "overwriteManual",
  "allowPrivateHosts",
  "allowCrossHost",
  "collectViaExtension",
] as const;

/** analyze_page_apis 的 4 种 action（scan_site 为放开分级后的静态推导入口）。 */
export type AnalyzeAction = "start" | "stop_and_analyze" | "analyze_current" | "scan_site";

/**
 * analyze_page_apis 的入参契约。
 *
 * 这里的每个可选开关都保留「未传 = undefined」这一状态 —— 编排层据此决定
 * 是否走默认值（见 api-command-types.ts 里的 SITE_SCAN_DEFAULT_* 常量）。
 */
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
  /**
   * 数据源：{kind, url} 或 {kind, text}，kind ∈ js/har/fiddler_saz/openapi/commands。
   *
   * `fiddler_saz` = Fiddler 导出的 SAZ 归档（与 har 同属真实流量归档）：
   * text 收 base64 的 .saz 本体 / 解包后的 raw HTTP 文本 / HTTP XML 文本；
   * url 收 http(s) 上的 .saz（按字节读取，base64 化后再解包）。
   */
  sources?: SiteScanSource[];
  /** 【黄区】允许内网 / 回环地址，默认 false。 */
  allowPrivateHosts?: boolean;
  /** 【黄区】允许跨 hostname 脚本源（CDN），默认 false，需同时给 extraHosts。 */
  allowCrossHost?: boolean;
  extraHosts?: string[];
  /** 规格类来源（openapi/commands）按声明方法判定 risk；默认 true（放开）。 */
  trustSpec?: boolean;
  /** 放宽 JS 路径判定，默认 true（放开）。 */
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
  /**
   * 【绿区·配置化放开】是否为命令标注证据档位（provenance）并在报告里输出覆盖率段。
   *
   * 三态：undefined = 走编排层默认值（`SITE_SCAN_DEFAULT_PROVENANCE`）；
   * 显式 true / false 均按调用方意愿生效 —— **显式传 false 依然是 false**，
   * 放开是默认值而非强制值，回退路径完好。
   */
  provenance?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 归一化可选布尔开关。
 *
 * @param raw     原始 tool args
 * @param key     开关名
 * @param triState true = 保留 undefined（编排层自己决定默认值）；
 *                 false = undefined 收敛成 false（编排层默认即 false）
 */
export function toBooleanArg(
  raw: Record<string, unknown>,
  key: TriStateBoolean | (typeof DEFAULT_FALSE_BOOLEANS)[number],
  triState: boolean,
): boolean | undefined {
  const value = raw[key];
  if (typeof value !== "boolean") return triState ? undefined : false;
  return value;
}

/**
 * 把 MCP 工具的 analyze_page_apis 入参归一化成编排层的 AnalyzeArgs。
 *
 * 关键点：**不把 undefined 压成 false**，让编排层自己的默认值语义生效。
 */
export function toAnalyzeArgs(rawInput: unknown): AnalyzeArgs {
  const raw = asRecord(rawInput);
  const out: Record<string, unknown> = {
    action: raw.action,
    domain: typeof raw.domain === "string" ? raw.domain : undefined,
    analysisId: typeof raw.analysisId === "string" ? raw.analysisId : undefined,
    tabId: typeof raw.tabId === "number" ? raw.tabId : undefined,
    filter: raw.filter && typeof raw.filter === "object" && !Array.isArray(raw.filter)
      ? raw.filter
      : undefined,
    maxEndpoints: typeof raw.maxEndpoints === "number" ? raw.maxEndpoints : undefined,
    mode: raw.mode === "full" ? "full" : raw.mode === "merge" ? "merge" : undefined,
    sources: Array.isArray(raw.sources) ? raw.sources : undefined,
    extraHosts: Array.isArray(raw.extraHosts)
      ? raw.extraHosts.filter((item): item is string => typeof item === "string")
      : undefined,
    scanTimeoutMs: typeof raw.scanTimeoutMs === "number" ? raw.scanTimeoutMs : undefined,
    bundleMaxSources: typeof raw.bundleMaxSources === "number" ? raw.bundleMaxSources : undefined,
  };

  // 三态开关：undefined 必须原样透传（编排层据此取默认值）。
  for (const key of TRI_STATE_BOOLEANS) {
    out[key] = toBooleanArg(raw, key, true);
  }
  // 默认即 false 的开关：undefined 收敛成 false。
  for (const key of DEFAULT_FALSE_BOOLEANS) {
    out[key] = toBooleanArg(raw, key, false);
  }

  return out as unknown as AnalyzeArgs;
}
