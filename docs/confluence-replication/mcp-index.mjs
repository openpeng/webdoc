#!/usr/bin/env node
/**
 * 方案 B 索引器 —— 把「目录条目」和「上游命令集缓存」对齐，产出可直接照着调的 commandId 清单。
 *
 * 为什么需要它：
 *   上游命令集按 pathTemplate 存命令，同一相对路径可能同时存在「裸形态」与「带 /confluence 前缀」
 *   两个 commandId（实测 217 条里 60 组并存）。裸形态调用必 404（JSESSIONID 的 path=/confluence，
 *   连会话 cookie 都带不上）。目录里的 source.commandId 有 58/182 指向裸形态那条 —— 不查就会踩。
 *
 * 用法：
 *   node mcp-index.mjs                      # Markdown 索引打到 stdout
 *   node mcp-index.mjs --json               # JSON
 *   node mcp-index.mjs --out index.md       # 写文件
 *   node mcp-index.mjs --cache <path>       # 指定 api-commands.json（默认自动探测）
 *   node mcp-index.mjs --domain <host>      # 指定域名（默认取目录 site.pageOrigin）
 *   node mcp-index.mjs --only direct        # 只看可直接调的（direct）
 *   node mcp-index.mjs --only bare          # 只看仅裸形态的（bare）
 *   node mcp-index.mjs --only noise          # 只看上游有、目录未收录的（noise）
 *
 * 判定口径：
 *   direct  —— 目录条目自身的 commandId，其 pathTemplate 就是带前缀形态 → 可直接 call_api_command
 *   alt     —— 自身是裸形态，但缓存里存在同路径的带前缀命令 → 改用该 commandId
 *   bare    —— 缓存里只有裸形态 → 直接调用必 404，需先 scan 出带前缀命令，或改走离线客户端
 *   noise   —— 上游缓存里有、但目录未收录（裸形态重复 / 噪音路径）→ 勿用
 *
 * 纪律：
 *   - 目录 JSON 是唯一事实源，本脚本不硬编码任何端点；
 *   - 找不到缓存就 fail-closed（exit 2），不产出「看起来完整」的索引；
 *   - 输出不含任何凭据值。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = join(HERE, "confluence-catalog.json");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const eq = arg.indexOf("=");
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 事实源
// ---------------------------------------------------------------------------
if (!existsSync(CATALOG_FILE)) fail(`找不到目录文件：${CATALOG_FILE}`, 2);
const catalog = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
const entries = catalog.entries ?? [];
const siteHost = catalog.site?.pageOrigin ?? "confluence.example.com";
const domain = typeof args.domain === "string" ? args.domain : siteHost;

// ---------------------------------------------------------------------------
// 上游命令集缓存（多候选，自动探测；fail-closed）
// ---------------------------------------------------------------------------
const CACHE_NAME = "api-commands.json";
function candidateCaches() {
  const list = [];
  const push = (p, why) => { if (p) list.push({ path: resolve(p), why }); };
  if (typeof args.cache === "string") push(args.cache, "--cache 指定");
  const dirEnv = process.env.WEBPILOT_API_COMMAND_DIR?.trim();
  const logEnv = process.env.WEBPILOT_TASK_LOG_DIR?.trim();
  if (dirEnv) push(join(dirEnv, CACHE_NAME), "WEBPILOT_API_COMMAND_DIR");
  if (logEnv) push(join(logEnv, CACHE_NAME), "WEBPILOT_TASK_LOG_DIR");
  push(join(process.cwd(), ".webpilot-task-logs", CACHE_NAME), "当前工作目录");
  push(join(homedir(), ".webpilot-task-logs", CACHE_NAME), "用户主目录");
  push(join(HERE, "..", "..", "mcp-server", ".webpilot-task-logs", CACHE_NAME), "仓库 mcp-server/");
  return list;
}

const candidates = candidateCaches();
const existing = candidates.filter((c) => existsSync(c.path));

// 多个候选时，优先选「确实包含目标域名命令组」的那份；否则 fail-closed。
let hit = null;
let parsedCache = null;
const seenDomains = [];
for (const c of existing) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(c.path, "utf8"));
  } catch (err) {
    seenDomains.push(`${c.path}（解析失败：${err.message}）`);
    continue;
  }
  const domains = Object.keys(parsed.domains ?? {});
  if (parsed.domains?.[domain]) {
    hit = c;
    parsedCache = parsed;
    break;
  }
  seenDomains.push(`${c.path}（域名：${domains.slice(0, 6).join(", ") || "无"}）`);
}

if (!hit) {
  fail(
    `找不到含域名 ${domain} 的上游命令集缓存（fail-closed，不产出残缺索引）。\n` +
    `已检查：\n${existing.length ? seenDomains.map((s) => `  - ${s}`).join("\n") : "  - 无候选文件存在"}\n` +
    "用 --cache <path> 显式指定；或先跑一次 analyze_page_apis 让 MCP 侧生成缓存。",
    2,
  );
}

const cache = parsedCache;
const group = cache.domains[domain];
const live = group.commands ?? [];

const byPath = new Map();
for (const c of live) {
  const p = c.request?.pathTemplate ?? "";
  if (!byPath.has(p)) byPath.set(p, []);
  byPath.get(p).push(c);
}

// ---------------------------------------------------------------------------
// 对齐
// ---------------------------------------------------------------------------
const rows = [];
for (const e of entries) {
  const cmdId = e.source?.commandId ?? null;
  const self = cmdId ? live.find((c) => c.commandId === cmdId) : null;
  const selfPath = self?.request?.pathTemplate ?? null;
  const prefixed = byPath.get(e.path) ?? [];

  let status;      // direct | alt | bare
  let useCmd = self;
  let usePath = selfPath;
  if (self && selfPath === e.path) {
    status = "direct";
  } else {
    const alt = prefixed.find((c) => c.commandId !== cmdId && (c.request?.method ?? "") === e.method);
    if (alt) {
      status = "alt";
      useCmd = alt;
      usePath = alt.request?.pathTemplate ?? null;
    } else {
      status = "bare";
      useCmd = self;
      usePath = selfPath;
    }
  }

  const required = (e.paramDetail ?? []).filter((p) => p.required).map((p) => p.name);
  rows.push({
    id: e.id,
    resource: e.resource,
    method: e.method,
    path: e.path,
    catalogCmdId: cmdId,
    catalogCmdName: e.source?.commandName ?? null,
    status,
    useCmdId: useCmd?.commandId ?? null,
    useCmdName: useCmd?.name ?? null,
    usePath,
    risk: e.risk,
    evidence: e.evidence,
    observed: e.evidence === "observed",
    required,
    hits: useCmd?.health?.hits ?? 0,
    misses: useCmd?.health?.misses ?? 0,
    lastError: useCmd?.health?.lastError ?? null,
    disabled: Boolean(useCmd?.health?.disabled),
  });
}

// 上游有、目录未收录
const catalogPaths = new Set(entries.map((e) => e.path));
const catalogCmdIds = new Set(entries.map((e) => e.source?.commandId).filter(Boolean));
const noise = live
  .filter((c) => {
    const p = c.request?.pathTemplate ?? "";
    return !catalogPaths.has(p) && !catalogCmdIds.has(c.commandId);
  })
  .map((c) => ({
    cmdId: c.commandId,
    name: c.name,
    path: c.request?.pathTemplate ?? "",
    method: c.request?.method ?? "",
    risk: c.risk,
    hits: c.health?.hits ?? 0,
    misses: c.health?.misses ?? 0,
    lastError: c.health?.lastError ?? null,
  }));

const tally = {
  direct: rows.filter((r) => r.status === "direct").length,
  alt: rows.filter((r) => r.status === "alt").length,
  bare: rows.filter((r) => r.status === "bare").length,
  write: rows.filter((r) => r.risk === "write").length,
  observed: rows.filter((r) => r.observed).length,
};
tally.usable = tally.direct + tally.alt;

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
  direct: "✅ 可直接调",
  alt: "🔁 改用替代命令",
  bare: "⚠️ 仅裸形态（调用必 404）",
};

function md() {
  const L = [];
  L.push("# Confluence 命令索引（方案 B）");
  L.push("");
  L.push("> 运行时快照，由 `mcp-index.mjs` 从「目录 JSON + 上游命令集缓存」生成，请勿手改；");
  L.push("> 缓存变了就重新跑生成器。");
  L.push("");
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push(`- 缓存文件：\`${hit.path}\`（${hit.why}）`);
  L.push(`- 域名：\`${domain}\`，上游命令 ${live.length} 条，目录条目 ${entries.length} 条`);
  L.push(`- 可直接调 **${tally.direct}**，改用替代 **${tally.alt}**，仅裸形态 **${tally.bare}**（合计可用 ${tally.usable}/${entries.length}）`);
  L.push(`- 其中写操作 ${tally.write} 条（risk=write，调用需 confirm:true），observed ${tally.observed} 条`);
  L.push(`- 上游有、目录未收录 ${noise.length} 条（勿用，见末节）`);
  L.push("");
  L.push("## 怎么用这张表");
  L.push("");
  L.push("1. 先在这里按业务语义找到目标端点 → 拿到 `commandId`；");
  L.push("2. 用 `get_api_command` 核对该命令的 `pathTemplate`；");
  L.push("3. 用 `call_api_command` 调用，`commandId` 直接传表里的值；");
  L.push("4. 标 ⚠️ 的行**不要直接调**（缓存里只有裸形态，必 404）。");
  L.push("");
  L.push("| 状态 | 含义 | 行动 |");
  L.push("|---|---|---|");
  L.push("| ✅ 可直接调 | 目录 commandId 的 pathTemplate 已是带 `/confluence` 前缀形态 | 直接 `call_api_command` |");
  L.push("| 🔁 改用替代命令 | 目录 commandId 是裸形态，但缓存里有同路径带前缀命令 | 用「可调 commandId」列的值 |");
  L.push("| ⚠️ 仅裸形态 | 缓存里只有裸形态 | 别调；先 scan 出带前缀命令，或改走离线客户端 |");
  L.push("");

  const byRes = new Map();
  for (const r of rows) {
    if (!byRes.has(r.resource)) byRes.set(r.resource, []);
    byRes.get(r.resource).push(r);
  }
  for (const [res, list] of byRes) {
    L.push(`## ${res}（${list.length}）`);
    L.push("");
    L.push("| 目录 id | 方法 | 规范路径 | 可调 commandId | 命令名 | 状态 | 证据 | 风险 | 必填参数 | 健康度 |");
    L.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of list) {
      const health = r.hits > 0 ? `hits ${r.hits}` : r.misses > 0 ? `miss ${r.misses}${r.lastError ? ` (${r.lastError})` : ""}` : "—";
      L.push(`| \`${r.id}\` | ${r.method} | \`${r.path}\` | ${r.useCmdId ? `\`${r.useCmdId}\`` : "—"} | \`${r.useCmdName ?? "—"}\` | ${STATUS_LABEL[r.status]} | ${r.evidence} | ${r.risk} | ${r.required.length ? r.required.map((x) => `\`${x}\``).join(" ") : "—"} | ${health} |`);
    }
    L.push("");
  }

  L.push(`## 上游有、目录未收录（勿用，共 ${noise.length} 条）`);
  L.push("");
  L.push("这些命令在活缓存里存在，但没有对应的带前缀目录条目；绝大多数是裸形态重复或噪音路径，调用必 404。");
  L.push("");
  L.push("| commandId | 命令名 | 方法 | 路径 | 风险 | 健康度 |");
  L.push("|---|---|---|---|---|---|");
  for (const n of noise) {
    const health = n.hits > 0 ? `hits ${n.hits}` : n.misses > 0 ? `miss ${n.misses}${n.lastError ? ` (${n.lastError})` : ""}` : "—";
    L.push(`| \`${n.cmdId}\` | \`${n.name}\` | ${n.method} | \`${n.path}\` | ${n.risk} | ${health} |`);
  }
  L.push("");
  return L.join("\n");
}

function json() {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    cacheFile: hit.path,
    cacheSource: hit.why,
    domain,
    upstreamCount: live.length,
    catalogCount: entries.length,
    tally,
    entries: rows,
    notInCatalog: noise,
  }, null, 2);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const only = typeof args.only === "string" ? args.only : null;
if (only && !["direct", "alt", "bare", "noise", "all"].includes(only)) {
  fail(`--only 只接受 direct | alt | bare | noise | all，收到：${only}`, 2);
}
if (only === "noise") {
  const payload = { generatedAt: new Date().toISOString(), cacheFile: hit.path, notInCatalog: noise };
  process.stdout.write(typeof args.json === "boolean" ? JSON.stringify(payload, null, 2) : noise.map((n) => `${n.cmdId}\t${n.method}\t${n.path}`).join("\n") + "\n");
  process.exit(0);
}

let text;
if (typeof args.json === "boolean") {
  text = json();
} else {
  const filtered = only === "all" ? rows : rows.filter((r) => r.status === only);
  const original = rows.length;
  text = md();
  if (only && only !== "all" && filtered.length !== original) {
    const idx = text.indexOf("## ");
    text = `# Confluence 命令索引（方案 B）— 过滤：${only}（${filtered.length}/${original}）\n\n` +
      filtered.map((r) => `${STATUS_LABEL[r.status]}\t${r.useCmdId ?? "—"}\t${r.method} ${r.path}\t${r.id}\t${r.risk}`).join("\n") + "\n";
  }
}

if (typeof args.out === "string") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.out, text, "utf8");
  process.stderr.write(`已写入 ${args.out}（${text.length} 字节）\n`);
  process.stderr.write(
    `对齐自检：目录 ${entries.length} 条 = 可直接调 ${tally.direct} + 替代 ${tally.alt} + 仅裸形态 ${tally.bare}；` +
    `上游 ${live.length} 条，其中目录未收录 ${noise.length} 条\n`,
  );
} else {
  process.stdout.write(text);
}
