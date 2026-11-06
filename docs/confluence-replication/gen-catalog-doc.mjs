#!/usr/bin/env node
/**
 * 由 <site>-catalog.json 生成「按资源域组织」的动作/端点目录 Markdown。
 *
 * 用法：node gen-catalog-doc.mjs [--catalog <catalog.json>] [--out <catalog.md>]
 *   --catalog 缺省取本目录下唯一的 *-catalog.json
 *   --out     缺省取同名目录下的 *-action-catalog.md
 *
 * 纪律：
 *  - 目录 JSON 是唯一事实源，本脚本只读它、只生成 Markdown；
 *  - fail-closed：条目缺 resource / resource 不存在 / id 重复 / 档位枚举非法 → 打印问题清单并 exit(1)，
 *    不静默产出「看起来完整」的目录（漏掉的条目会在你不知情时消失）；
 *  - 幂等：同样的输入跑两遍，输出相同；
 *  - 只用 node:fs，不联网、不读凭据。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = ["observed", "derived", "unknown"];
const RISKS = ["read", "write"];
const KINDS = ["action", "endpoint"];

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

function defaultCatalog() {
  const candidates = readdirSync(HERE).filter((f) => f.endsWith("-catalog.json"));
  if (candidates.length !== 1) {
    throw new Error(`本目录下应恰好有一个 *-catalog.json，实际找到 ${candidates.length} 个（${candidates.join(", ") || "无"}）；请用 --catalog 指定`);
  }
  return join(HERE, candidates[0]);
}

const catalogPath = typeof args.catalog === "string" ? args.catalog : defaultCatalog();
const defaultOut = join(dirname(catalogPath), `${basename(catalogPath).replace(/-catalog\.json$/, "")}-action-catalog.md`);
const outPath = typeof args.out === "string" ? args.out : defaultOut;

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
const resources = Array.isArray(catalog.resources) ? catalog.resources : [];

// ---- fail-closed 校验 ----
const problems = [];
const resourceIds = new Set(resources.map((r) => r && r.id).filter(Boolean));
const seenIds = new Set();
for (const entry of entries) {
  if (!entry || typeof entry !== "object") { problems.push("有条目不是对象"); continue; }
  if (!entry.id) problems.push("有条目缺 id");
  else if (seenIds.has(entry.id)) problems.push(`id 重复：${entry.id}`);
  else seenIds.add(entry.id);
  if (!entry.resource) problems.push(`${entry.id} 未归入资源域`);
  else if (!resourceIds.has(entry.resource)) problems.push(`${entry.id} 的 resource「${entry.resource}」不在 resources[] 里`);
  if (!EVIDENCE.includes(entry.evidence)) problems.push(`${entry.id} 的 evidence 非法：${entry.evidence}`);
  if (!RISKS.includes(entry.risk)) problems.push(`${entry.id} 的 risk 非法：${entry.risk}`);
  if (!KINDS.includes(entry.kind)) problems.push(`${entry.id} 的 kind 非法：${entry.kind}`);
}
if (entries.length === 0) problems.push("目录里没有 entries");
if (resources.length === 0) problems.push("目录里没有 resources");
if (problems.length) {
  process.stderr.write(`目录校验未通过（${problems.length} 项）：\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write("先把上面的问题修好再生成文档；缺 resource 的条目必须先归类。\n");
  process.exit(1);
}

// ---- 生成 Markdown ----
const TIER_MARK = { observed: "✔ observed", derived: "~ derived", unknown: "? unknown" };
const byResource = new Map(resources.map((r) => [r.id, []]));
for (const entry of entries) byResource.get(entry.resource).push(entry);

function label(entry) {
  return entry.kind === "endpoint" ? `${entry.method} ${entry.path}` : entry.id;
}
function compactParams(params) {
  const text = JSON.stringify(params ?? {});
  return text === "{}" ? "—" : (text.length > 150 ? `${text.slice(0, 147)}…` : text);
}
function esc(text) {
  return String(text ?? "").replace(/\|/g, "\\|");
}

const lines = [];
lines.push(`# ${catalog.site?.name ?? "站点"} 动作目录（按资源域）`);
lines.push("");
lines.push(`> 数据源：[\`${basename(catalogPath)}\`](./${basename(catalogPath)})（唯一事实源，本文件由 \`${basename(fileURLToPath(import.meta.url))}\` 生成）`);
lines.push("");

lines.push("## 总览");
lines.push("");
lines.push("| 资源域 | 条目数 | observed | derived | unknown | 说明 |");
lines.push("|---|---:|---:|---:|---:|---|");
let tObserved = 0; let tDerived = 0; let tUnknown = 0;
for (const resource of resources) {
  const items = byResource.get(resource.id);
  const o = items.filter((i) => i.evidence === "observed").length;
  const d = items.filter((i) => i.evidence === "derived").length;
  const u = items.filter((i) => i.evidence === "unknown").length;
  tObserved += o; tDerived += d; tUnknown += u;
  lines.push(`| ${esc(resource.id)} | ${items.length} | ${o} | ${d} | ${u} | ${esc(resource.description ?? "")} |`);
}
lines.push(`| **合计** | **${entries.length}** | **${tObserved}** | **${tDerived}** | **${tUnknown}** | |`);
lines.push("");
lines.push("档位含义：**✔ observed** = 真实请求验证过业务成功且拿到数据；**~ derived** = 动作/端点与参数形态来自前端代码或规格，未实测；**? unknown** = 仅确认名称存在，参数形态未知。");
lines.push("");

if (catalog.transport) {
  const t = catalog.transport;
  lines.push("## 调用形态（所有条目共用）");
  lines.push("");
  lines.push("```");
  lines.push(`${t.method ?? "POST"} https://${(catalog.site?.apiHosts ?? [])[0] ?? "<api-host>"}${t.endpoint ?? "<path>"}`);
  if (t.contentType) lines.push(`Content-Type: ${t.contentType}`);
  for (const req of t.auth?.required ?? []) lines.push(`${req}`);
  if (t.body) { lines.push(""); lines.push(t.body); }
  lines.push("```");
  if (t.batch) {
    lines.push("");
    lines.push(`批量：\`${t.batch.endpoint}?${t.batch.query}\`，body \`${t.batch.body}\`；${t.batch.responseIndex ?? ""}`);
  }
  if (t.response?.successRule) {
    lines.push("");
    lines.push(`成功判定：${t.response.successRule}${t.response.doubleEncodedFields?.length ? `；二次编码字段：${t.response.doubleEncodedFields.join(", ")}` : ""}`);
  }
  lines.push("");
}

for (const resource of resources) {
  const items = byResource.get(resource.id);
  if (items.length === 0) continue;
  lines.push(`## ${resource.id}`);
  if (resource.description) lines.push(`_${resource.description}_`);
  lines.push("");
  lines.push("| 条目 | 档位 | 风险 | 关键参数 | 返回结构 | 说明 |");
  lines.push("|---|---|---|---|---|---|");
  for (const item of items) {
    const risk = item.risk === "write" ? "⚠ write" : "read";
    lines.push(`| \`${esc(label(item))}\` | ${TIER_MARK[item.evidence]} | ${risk} | ${esc(compactParams(item.params))} | ${esc(item.dataShape || "—")} | ${esc(item.note || "")} |`);
  }
  lines.push("");
}

if (Array.isArray(catalog.excluded) && catalog.excluded.length) {
  lines.push("## 明确排除（不在本次复刻范围）");
  lines.push("");
  lines.push("| 主机 / 接口族 | 排除原因 |");
  lines.push("|---|---|");
  for (const item of catalog.excluded) {
    lines.push(`| ${esc(item.host ?? "")}<br>\`${esc((item.actions ?? []).join("`, `"))}\` | ${esc(item.reason ?? "")} |`);
  }
  lines.push("");
}

// ---- 实测样例（来自目录里带 verification 的条目，真实 HTTP 结果）----
const verifiedEntries = entries.filter((e) => e.verification && e.verification.httpStatus);
if (verifiedEntries.length) {
  lines.push("## 实测样例");
  lines.push("");
  lines.push("| 条目 | 方法 | 路径 | HTTP | 结论 |");
  lines.push("|---|---|---|---:|---|");
  for (const item of verifiedEntries) {
    lines.push(`| \`${esc(item.id)}\` | ${esc(item.method)} | \`${esc(item.path)}\` | ${item.verification.httpStatus} | ${esc(item.verification.note ?? "")} |`);
  }
  lines.push("");
}

// ---- 已知坑（目录里登记的坑位，未登记的坑不在此列）----
if (Array.isArray(catalog.knownPitfalls) && catalog.knownPitfalls.length) {
  lines.push("## 已知坑");
  lines.push("");
  lines.push("| 坑 | 影响 | 规避 |");
  lines.push("|---|---|---|");
  for (const item of catalog.knownPitfalls) {
    lines.push(`| ${esc(item.pitfall ?? "")} | ${esc(item.impact ?? "")} | ${esc(item.workaround ?? "")} |`);
  }
  lines.push("");
}

writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`已生成 ${outPath}\n`);
process.stdout.write(`资源域 ${resources.length} 个，条目 ${entries.length} 个（observed ${tObserved} / derived ${tDerived} / unknown ${tUnknown}）\n`);
if (catalog.transport?.batch?.endpoint) {
  process.stdout.write(`批量形态：${catalog.transport.batch.endpoint}?${catalog.transport.batch.query ?? ""}\n`);
}
