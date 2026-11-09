#!/usr/bin/env node
/**
 * <站点中文名> —— 无 UI API 客户端（目录驱动）。
 *
 * 由 .minimax/skills/webdoc-replication-deliverables/scripts/scaffold-replication.mjs 生成。
 * 形状规范见该 skill 的 references/deliverable-shapes.md。
 *
 * 目录文件：__CATALOG_FILE__（唯一事实源；本客户端不硬编码任何参数）
 *
 * 用法：
 *   node __SLUG__-api.mjs --list
 *   node __SLUG__-api.mjs --action <Id> --from-catalog --set k=v --cookie-file cookie.txt
 *   node __SLUG__-api.mjs --multi <Id1>,<Id2> --from-catalog --cookie-file cookie.txt
 *
 * 退出码：0 成功 / 2 参数错（含缺凭据）/ 3 被重定向（凭据过期）/ 4 业务返回非 200
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = "__CATALOG_FILE__";
const catalog = JSON.parse(readFileSync(join(HERE, CATALOG_FILE), "utf8"));
const TRANSPORT = catalog.transport ?? {};
const SITE = catalog.site ?? {};

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [], set: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--set") { out.set.push(argv[i + 1] ?? ""); i += 1; continue; }
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

function entryById(id) {
  return (catalog.entries ?? []).find((item) => item.id === id);
}

// ---------------------------------------------------------------------------
// 凭据：只从 --cookie-file / --cookie / 环境变量读，绝不硬编码进仓库
// ---------------------------------------------------------------------------
function readCookie() {
  if (typeof args["cookie-file"] === "string" && args["cookie-file"]) {
    return readFileSync(args["cookie-file"], "utf8").trim();
  }
  if (typeof args.cookie === "string" && args.cookie) return args.cookie.trim();
  if (process.env.SITE_COOKIE) return process.env.SITE_COOKIE.trim();
  return "";
}

// ---------------------------------------------------------------------------
// 参数合成：目录基底（--from-catalog）+ 整体覆盖 + --set 逐项覆盖
// ---------------------------------------------------------------------------
function buildParams(id) {
  const entry = entryById(id);
  let params = {};
  if (args["from-catalog"] === true && entry && entry.params) {
    params = JSON.parse(JSON.stringify(entry.params));
  }
  const text = (typeof args["params-file"] === "string" && args["params-file"])
    ? readFileSync(args["params-file"], "utf8")
    : (typeof args.params === "string" ? args.params : "");
  if (text.trim()) {
    try { params = { ...params, ...JSON.parse(text) }; }
    catch (err) { fail(`--params 不是合法 JSON: ${err.message}`); }
  }
  for (const pair of args.set) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}

// ---------------------------------------------------------------------------
// --list：按资源域分组
// ---------------------------------------------------------------------------
if (args.list === true) {
  const groups = new Map();
  for (const item of catalog.entries ?? []) {
    const key = item.resource || "未分类";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [group, items] of groups) {
    process.stdout.write(`\n${group}（${items.length}）\n`);
    for (const item of items) {
      const mark = item.evidence === "observed" ? "✔" : item.evidence === "derived" ? "~" : "?";
      const risk = item.risk === "write" ? "  ⚠ write" : "";
      process.stdout.write(`  ${mark} ${item.id}${risk}\n`);
    }
  }
  process.stdout.write(`\n合计 ${(catalog.entries ?? []).length} 个条目 / ${groups.size} 个资源域；✔=observed  ~=derived  ?=unknown\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------
const host = typeof args.host === "string" ? args.host : (SITE.apiHosts ?? [])[0];
if (!host) fail("目录里没有 site.apiHosts，也没有传 --host", 2);
const region = typeof args.region === "string" ? args.region : (SITE.region ?? "");
const origin = typeof args.origin === "string" ? args.origin : (SITE.pageOrigin ? `https://${SITE.pageOrigin}` : "");
const cookie = readCookie();
if (!cookie) fail("缺少凭据：用 --cookie-file <path>、--cookie <str> 或环境变量 SITE_COOKIE 提供会话 cookie。", 2);

function requestHeaders() {
  const headers = {
    "Content-Type": TRANSPORT.contentType ?? "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
  };
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  }
  headers.Cookie = cookie;
  return headers;
}

/** 网关型：form-urlencoded，params 是 JSON 字符串。REST 型：path + query。 */
function buildRequest(id, params) {
  const entry = entryById(id);
  const method = (entry?.method ?? TRANSPORT.method ?? "POST").toUpperCase();
  const endpoint = entry?.path ?? TRANSPORT.endpoint ?? "/";
  if (TRANSPORT.kind === "rpc-gateway") {
    const url = `https://${host}${endpoint}?${encodeURIComponent(id)}`;
    const body = new URLSearchParams({
      product: TRANSPORT.product ?? "arms",
      action: id,
      region,
      params: JSON.stringify(params),
    }).toString();
    return { url, method, body };
  }
  // REST 型：params 里的标量进 query，对象进 JSON body
  const query = new URLSearchParams();
  const bodyObj = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && typeof value === "object") bodyObj[key] = value;
    else if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  const url = `https://${host}${endpoint.replace(/\{(\w+)\}/g, (_m, k) => encodeURIComponent(String(params[k] ?? "")))}${qs ? `?${qs}` : ""}`;
  const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify(bodyObj);
  return { url, method, body };
}

async function send(url, method, body) {
  const resp = await fetch(url, { method, headers: requestHeaders(), ...(body ? { body } : {}), redirect: "manual" });
  if (resp.status >= 300 && resp.status < 400) {
    fail(`HTTP ${resp.status} 被重定向到 ${resp.headers.get("location") || "(无 Location)"} —— 会话 cookie 可能已过期`, 3);
  }
  const text = await resp.text();
  try { return { http: resp.status, ...JSON.parse(text) }; }
  catch { return { http: resp.status, code: "nonJSON", message: text.slice(0, 200) }; }
}

/** 很多网关的 data.Data 是二次编码的 JSON 字符串，展开一层更方便看。 */
function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const d = payload.data;
  if (d && typeof d === "object" && typeof d.Data === "string") {
    try { return { ...payload, data: { ...d, Data: JSON.parse(d.Data) } }; }
    catch { return payload; }
  }
  return payload;
}

function pick(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------------------
// 批量：走网关的 multi 端点，一次 HTTP 拿多个动作
// ---------------------------------------------------------------------------
const multi = typeof args.multi === "string" ? args.multi.split(",").map((s) => s.trim()).filter(Boolean) : [];
if (multi.length > 0) {
  if (!TRANSPORT.batch?.endpoint) fail("目录里没有 transport.batch —— 该站点不支持批量调用", 2);
  const actions = multi.map((id) => ({ action: id, params: buildParams(id) }));
  const url = `https://${host}${TRANSPORT.batch.endpoint}?${encodeURIComponent(actions.map((a) => a.action).join("~"))}`;
  const body = new URLSearchParams({
    product: TRANSPORT.product ?? "arms",
    actions: JSON.stringify(actions),
  }).toString();
  const result = unwrap(await send(url, TRANSPORT.method ?? "POST", body));
  const data = result.data ?? {};
  for (const [index, item] of Object.entries(data)) {
    const name = actions[Number(index)]?.action ?? index;
    process.stdout.write(`\n=== [${index}] ${name} success=${item.success} code=${item.code} ===\n`);
    const inner = item.data && typeof item.data.Data === "string"
      ? { ...item.data, Data: safeParse(item.data.Data) } : item.data;
    process.stdout.write(`${JSON.stringify(inner, null, 2)}\n`);
  }
  process.exit(result.code === "200" ? 0 : 4);
}

// ---------------------------------------------------------------------------
// 单动作
// ---------------------------------------------------------------------------
const id = typeof args.action === "string" ? args.action : "";
if (!id) fail("用法: node __SLUG__-api.mjs --action <Id> [--multi A,B,C] [--list]", 2);
if (!entryById(id) && args.strict === true) {
  fail(`目录里没有条目 ${id}（去掉 --strict 可强行调用）`, 2);
}
const request = buildRequest(id, buildParams(id));
const result = unwrap(await send(request.url, request.method, request.body));

if (args.raw === true) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (typeof args.pick === "string") {
  process.stdout.write(`${JSON.stringify(pick(result, args.pick), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
process.exit(result.code === "200" || result.successResponse === true ? 0 : 4);
