/**
 * WebPilot API 命令集 —— 证据分级 / 歧义显式 / 覆盖率聚合（**无 IO 纯函数层**）。
 *
 * 借鉴 REA（Reverse Engineer Anything）的**口径**而非代码：
 *  - 证据分级：observed / derived / inferred / unknown 四档，缺失即 unknown，
 *    不把「没观察到」冒充「已覆盖」；
 *  - 歧义显式：证据支持多个互斥结论时**不猜**，而是显式记录候选；
 *  - 覆盖率：产出可排序的分档计数 + 下一步提示（hint），不只给一个 0..1 的 confidence。
 *
 * 硬约束：本文件不 import node:fs、不读环境变量、不读 Date.now()、
 * 不依赖任何 MCP server 运行时单例。所有导出函数可被 `node --test` 直接单测。
 *
 * 关键纪律：
 *  1. 档位只反映**证据强度**，不反映 risk / 可执行性 —— 风险闸门独立判定。
 *  2. 总档位取三个维度中最弱的一档（端点再确定，响应靠猜，整条命令仍不可信）。
 *  3. 任何对外文案都只给**计数与档位**，绝不回显 host、路径、样本值。
 */
import {
  COMMAND_TIERS,
  COMMAND_TIER_STRENGTH,
  COVERAGE_HINT_AMBIGUOUS,
  COVERAGE_HINT_DERIVED,
  COVERAGE_HINT_INFERRED,
  COVERAGE_HINT_MISSING_RESPONSE,
  COVERAGE_HINT_UNVERIFIED,
} from "./api-command-types.js";
import type {
  AnalysisCoverage,
  CommandProvenance,
  CommandTier,
  DomainCoverage,
  ScanAmbiguity,
  ScanAmbiguityKind,
  SiteScanKind,
} from "./api-command-types.js";

// ---------------------------------------------------------------------------
// 1. 档位基础工具
// ---------------------------------------------------------------------------

/** 归一化任意输入成合法档位；无法识别时返回 unknown（缺失即未知，不猜）。 */
export function normalizeTier(value: unknown): CommandTier {
  return typeof value === "string" && (COMMAND_TIERS as readonly string[]).includes(value)
    ? value as CommandTier
    : "unknown";
}

/** 取一组档位中最弱的一档（unknown 恒为最弱）。 */
export function weakestTier(tiers: Array<CommandTier | undefined>): CommandTier {
  let weakest: CommandTier = "observed";
  let seen = false;
  for (const tier of tiers) {
    if (!tier) continue;
    seen = true;
    if (COMMAND_TIER_STRENGTH[tier] < COMMAND_TIER_STRENGTH[weakest]) weakest = tier;
  }
  return seen ? weakest : "unknown";
}

// ---------------------------------------------------------------------------
// 2. 来源种类 → 证据档位
// ---------------------------------------------------------------------------

/**
 * 静态推导来源种类 → 该来源单独能支撑的端点证据档位。
 *
 *  - `har` / `fiddler_saz`：**真实流量归档**（HAR / Fiddler SAZ 导出的会话），
 *    端点确实被调用过 → observed；
 *  - `openapi` / `commands`：权威声明 → derived；
 *  - `js`：前端 bundle 里的路径字面量 → inferred（可能来自注释、死代码、实验分支）。
 */
const SCAN_KIND_TIER: Readonly<Record<SiteScanKind, CommandTier>> = {
  har: "observed",
  fiddler_saz: "observed",
  openapi: "derived",
  commands: "derived",
  js: "inferred",
};

/** 单个来源种类的端点证据档位。 */
export function tierForSourceKind(kind: SiteScanKind | undefined): CommandTier {
  if (!kind) return "unknown";
  return SCAN_KIND_TIER[kind] ?? "unknown";
}

/**
 * 多个来源种类合并后的端点证据档位：**取最强的一档**。
 *
 * 取最强而不是最弱：同一个端点若既出现在 HAR 归档流量里、又出现在前端 bundle 里，
 * 端点身份是被**观测**到的；bundle 那份弱证据不构成对该端点的否定。
 */
export function tierForSourceKinds(kinds: SiteScanKind[] | undefined): CommandTier {
  const list = Array.isArray(kinds) ? kinds : [];
  let best: CommandTier = "unknown";
  for (const kind of list) {
    const tier = tierForSourceKind(kind);
    if (COMMAND_TIER_STRENGTH[tier] > COMMAND_TIER_STRENGTH[best]) best = tier;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. 通道来源 → 证据档位
// ---------------------------------------------------------------------------

/**
 * 抓包 / 人工通道的来源 → 端点证据档位。
 *
 *  - `capture`：真实抓包观测 → observed；
 *  - `manual`：人工录入 / 人工修正 → derived（人确认过，但未必经机器验证）；
 *  - `spec`：规格声明 → derived；
 *  - `scan`：静态推导，档位由具体来源种类决定（见 tierForSourceKinds）。
 */
export function tierForOrigin(origin: string | undefined): CommandTier {
  switch (origin) {
    case "capture": return "observed";
    case "manual": return "derived";
    case "spec": return "derived";
    case "scan": return "unknown";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// 4. 三维档位组装
// ---------------------------------------------------------------------------

export interface ProvenanceInput {
  /** 端点证据来源种类（静态推导通道）。 */
  sourceKinds?: SiteScanKind[];
  /** 通道来源（capture / scan / spec / manual）。 */
  origin?: string;
  /** 响应结构是否有真实样本支撑。 */
  hasResponseSample?: boolean;
  /** 参数是否有真实观测支撑（抓包通道恒为 true；静态推导按来源种类判定）。 */
  hasObservedParams?: boolean;
}

/**
 * 组装一条命令的三维证据档位。
 *
 * - endpoint：来源种类 / 通道来源决定；
 * - params：静态推导按来源种类（HAR 有真实参数名 → observed；bundle 字符串 → inferred）；
 * - response：**只有拿到真实响应样本才是 observed**，否则 unknown ——
 *   静态推导永远没有响应样本，响应档位恒为 unknown。
 *
 * 总档位取三维最弱档。
 */
export function deriveProvenance(input: ProvenanceInput): CommandProvenance {
  const kinds = Array.isArray(input?.sourceKinds) ? input.sourceKinds : [];
  const endpoint = kinds.length > 0
    ? tierForSourceKinds(kinds)
    : tierForOrigin(input?.origin);

  const params = kinds.length > 0
    ? tierForSourceKinds(kinds)
    : (input?.hasObservedParams === true ? "observed" : tierForOrigin(input?.origin));

  const response: CommandTier = input?.hasResponseSample === true ? "observed" : "unknown";

  return {
    tier: weakestTier([endpoint, params, response]),
    endpoint,
    params,
    response,
  };
}

/** 两个来源集合是否一致（用于判定「来源冲突」）。 */
export function sameSourceKinds(
  a: SiteScanKind[] | undefined,
  b: SiteScanKind[] | undefined,
): boolean {
  const left = [...new Set(Array.isArray(a) ? a : [])].sort();
  const right = [...new Set(Array.isArray(b) ? b : [])].sort();
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

// ---------------------------------------------------------------------------
// 5. 歧义显式化
// ---------------------------------------------------------------------------

/**
 * 构造一条歧义记录。candidates 为空时视为来源冲突（证据不一致而非多解）。
 */
export function makeAmbiguity(
  kind: ScanAmbiguityKind,
  candidates: string[],
  pathTemplate?: string,
): ScanAmbiguity {
  const unique = [...new Set((Array.isArray(candidates) ? candidates : []).filter(
    (item) => typeof item === "string" && item.length > 0,
  ))];
  return {
    kind,
    ...(pathTemplate ? { pathTemplate } : {}),
    candidates: unique,
    candidateCount: unique.length,
  };
}

/**
 * 同一路径模板出现多个 host 证据 → host 歧义。
 *
 * 纪律：**不猜**。调用方据此知道「这条端点的主机归属不确定」。
 */
export function hostAmbiguity(pathTemplate: string, hosts: string[]): ScanAmbiguity | undefined {
  const unique = [...new Set(hosts)];
  if (unique.length <= 1) return undefined;
  return makeAmbiguity("host", unique, pathTemplate);
}

/** 多个 baseURL 候选 → baseUrl 歧义。 */
export function baseUrlAmbiguity(hosts: string[]): ScanAmbiguity | undefined {
  const unique = [...new Set(hosts)];
  if (unique.length <= 1) return undefined;
  return makeAmbiguity("baseUrl", unique);
}

// ---------------------------------------------------------------------------
// 6. 覆盖率聚合
// ---------------------------------------------------------------------------

export interface CoverageInput {
  endpointCount: number;
  /** 每条命令的完整证据档位（用于分档统计与三维拆分）。 */
  provenances: CommandProvenance[];
  /** 响应已验证（response 档位为 observed）的命令数。 */
  verifiedCount: number;
  ambiguities: ScanAmbiguity[];
  /**
   * 统计口径：`domain` = 该域名的全量命令集；`batch` = 仅本次分析批次。
   *
   * 缺省 `batch`（保持既有行为）。口径必须显式标注 —— 批次口径会把整域可信度高估
   * （实测 Confluence 复刻：批次显示 observed=10/unknown=4，域名实为 54 条）。
   */
  scope?: "domain" | "batch";
  /** 本次分析批次的命令数（与 scope 口径下的 commandCount 区分）。 */
  batchCommandCount?: number;
  /**
   * 本次批次的档位明细（对照用）。
   *
   * 有了它才能在报告里同时给出「批次数字」与「域名真实数字」，
   * 调用方一眼能看出批次口径虚高多少。
   */
  batchProvenances?: CommandProvenance[];
  /**
   * 按域名的档位明细：key = 精确 hostname，value = 该域名**全量**命令的档位。
   *
   * 跨 host 的命令各自属于另一个域名，必须单独统计，否则它们的档位会被算丢。
   */
  domainProvenances?: Record<string, CommandProvenance[]>;
}

/**
 * 覆盖率比例（0..1，保留 3 位小数）。
 *
 * 分母为 0 时返回 0 —— 「一条命令都没有」不等于「覆盖率 100%」。
 */
export function coverageRate(observed: number, denominator: number): number {
  const num = Number.isFinite(observed) ? Math.max(0, observed) : 0;
  const den = Number.isFinite(denominator) ? Math.max(0, denominator) : 0;
  if (den === 0) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * 统计**去重后的真实端点数**（method + host + pathTemplate）。
 *
 * 命令数 ≠ 端点数：同一条端点可能对应多条命令（人工分叉 / 不同模板变体）。
 * 覆盖率报告里的 endpointCount 必须是端点数，否则就是拿命令数冒充端点数。
 */
export function countDistinctEndpoints(
  items: Array<{ method?: string; pathTemplate?: string; host?: string }> | undefined,
): number {
  const list = Array.isArray(items) ? items : [];
  const keys = new Set<string>();
  for (const item of list) {
    const method = String(item?.method ?? "").toUpperCase();
    const path = String(item?.pathTemplate ?? "");
    if (!path) continue;
    keys.add(`${method}\u0000${String(item?.host ?? "")}\u0000${path}`);
  }
  return keys.size;
}

/**
 * 聚合覆盖率报告。
 *
 * 纪律：
 *  - byTier 各档之和恒等于 commandCount（不丢项、不重复计数）；
 *  - byDimension 把三维分别统计 —— 回答「不确定性到底出在哪一维」；
 *  - **分母显式**（denominator）+ **真实覆盖率**（coverageRate）：调用方不必再自己拿批次当分母去算 —— 那正是数字虚高的根源；
 *  - nextHints 由**计数触发**，每条固定文案只出现一次，不含任何样本值 / host / 路径；
 *  - 缺失的部分计入 unknown 档，**不冒充已覆盖**。
 */
export function buildCoverage(input: CoverageInput): AnalysisCoverage {
  const list = Array.isArray(input?.provenances) ? input.provenances : [];
  const byTier = { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>;
  const byDimension = {
    endpoint: { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>,
    params: { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>,
    response: { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>,
  };
  for (const provenance of list) {
    const safe = provenance ?? { tier: "unknown", endpoint: "unknown", params: "unknown", response: "unknown" };
    byTier[normalizeTier(safe.tier)] += 1;
    byDimension.endpoint[normalizeTier(safe.endpoint)] += 1;
    byDimension.params[normalizeTier(safe.params)] += 1;
    byDimension.response[normalizeTier(safe.response)] += 1;
  }

  const ambiguities = Array.isArray(input?.ambiguities) ? input.ambiguities : [];
  const verifiedCount = Number.isFinite(input?.verifiedCount) ? Math.max(0, Math.floor(input!.verifiedCount)) : 0;

  const nextHints: string[] = [];
  const addHint = (text: string) => { if (!nextHints.includes(text)) nextHints.push(text); };
  if (byDimension.response.unknown > 0) addHint(COVERAGE_HINT_MISSING_RESPONSE);
  if (byDimension.endpoint.inferred > 0) addHint(COVERAGE_HINT_INFERRED);
  if (byDimension.endpoint.derived > 0) addHint(COVERAGE_HINT_DERIVED);
  if (ambiguities.length > 0) addHint(COVERAGE_HINT_AMBIGUOUS);
  if (list.length > verifiedCount) addHint(COVERAGE_HINT_UNVERIFIED);

  const scope: "domain" | "batch" = input?.scope === "domain" ? "domain" : "batch";
  const rawBatchCount = input?.batchCommandCount;
  const batchCommandCount = typeof rawBatchCount === "number" && Number.isFinite(rawBatchCount)
    ? Math.max(0, Math.floor(rawBatchCount))
    : list.length;

  // 分母 = 口径内的命令数；真实覆盖率 = **端点被真实流量观测到**的命令数 / 分母。
  //
  // 分子取「端点维度」的 observed，而不是「总档位」的 observed ——
  // 总档位是三维取最弱，而静态推导永远拿不到响应样本（response 恒 unknown），
  // 拿它当分子会让任何静态推导域的覆盖率恒为 0：
  // 「这个域的接口一个都没被观测到」与事实相反（HAR / SAZ 归档里的端点确实被观测过）。
  // 端点维度的比例才是「这个域的接口有多少是被真实流量观测到的」；
  // 三维各自的比例见 dimensionRates，总档位分布见 byTier。
  const denominator = list.length;
  const dimensionRates = {
    endpoint: coverageRate(byDimension.endpoint.observed, denominator),
    params: coverageRate(byDimension.params.observed, denominator),
    response: coverageRate(byDimension.response.observed, denominator),
  };

  // 批次对照：同一批命令单独算一份，调用方能直接看出批次口径虚高多少。
  // 分子口径与主口径一致（端点维度 observed），否则两列数字不可比。
  const batchList = Array.isArray(input?.batchProvenances) ? input.batchProvenances : [];
  const batchStats = batchList.length > 0 ? (() => {
    const batchByTier = { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>;
    let batchEndpointObserved = 0;
    for (const provenance of batchList) {
      const safe = provenance ?? { tier: "unknown" };
      batchByTier[normalizeTier(safe.tier)] += 1;
      if (normalizeTier(safe.endpoint) === "observed") batchEndpointObserved += 1;
    }
    return {
      commandCount: batchList.length,
      byTier: batchByTier,
      coverageRate: coverageRate(batchEndpointObserved, batchList.length),
    };
  })() : undefined;

  // 按域名的真实覆盖率：每个域名的分母都是**它自己的全量命令数**。
  const domainEntries = input?.domainProvenances;
  const byDomain: Record<string, DomainCoverage> = {};
  if (domainEntries && typeof domainEntries === "object") {
    for (const [host, rawList] of Object.entries(domainEntries)) {
      const domainList = Array.isArray(rawList) ? rawList : [];
      const domainByTier = { observed: 0, derived: 0, inferred: 0, unknown: 0 } as Record<CommandTier, number>;
      let domainEndpointObserved = 0;
      for (const provenance of domainList) {
        const safe = provenance ?? { tier: "unknown" };
        domainByTier[normalizeTier(safe.tier)] += 1;
        if (normalizeTier(safe.endpoint) === "observed") domainEndpointObserved += 1;
      }
      byDomain[host] = {
        commandCount: domainList.length,
        byTier: domainByTier,
        coverageRate: coverageRate(domainEndpointObserved, domainList.length),
      };
    }
  }

  return {
    scope,
    batchCommandCount,
    endpointCount: Number.isFinite(input?.endpointCount) ? Math.max(0, Math.floor(input!.endpointCount)) : 0,
    commandCount: list.length,
    byTier,
    byDimension,
    verifiedCount,
    ambiguities,
    nextHints,
    denominator,
    coverageRate: coverageRate(byDimension.endpoint.observed, denominator),
    dimensionRates,
    ...(batchStats ? { batchStats } : {}),
    ...(Object.keys(byDomain).length > 0 ? { byDomain } : {}),
  };
}

/** 覆盖率各档之和是否等于命令总数（自检用）。 */
export function coverageCountsConsistent(coverage: AnalysisCoverage | undefined): boolean {
  if (!coverage) return false;
  const sum = coverage.byTier.observed + coverage.byTier.derived
    + coverage.byTier.inferred + coverage.byTier.unknown;
  return sum === coverage.commandCount;
}
