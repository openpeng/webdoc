#!/usr/bin/env node
/**
 * 示例 Confluence 知识库 —— 无 UI API 客户端（目录驱动）。
 *
 * 目录文件：confluence-catalog.json（唯一事实源；本客户端不硬编码任何参数）
 * 形状规范见 mcp-server/skills/webdoc-replication-deliverables/references/deliverable-shapes.md
 *
 * 用法：
 *   node confluence-api.mjs --list
 *   node confluence-api.mjs --action <Id> --from-catalog --cookie-file cookie.txt
 *   node confluence-api.mjs --action <Id> --set id=<pageId> --cookie-file cookie.txt
 *   node confluence-api.mjs --multi <Id1>,<Id2> --from-catalog --cookie-file cookie.txt
 *
 * 退出码：0 成功 / 2 参数错（含缺凭据、缺必填参数、拒写）/ 3 被重定向 / 4 业务返回非 2xx
 *
 * 纪律：
 *  - 凭据只从 --cookie-file / --cookie / 环境变量 CONFLUENCE_COOKIE 读，仓库里不留任何凭据值；
 *  - 目录里没有的条目，--strict 下直接拒绝；去掉 --strict 会按传入的 id 当路径模板拼；
 *  - risk=write 的条目默认拒发，必须显式 --confirm-write（这不是安全边界，只防误触发）；
 *  - 参数校验不过时零网络请求；
 *  - 重定向不跟随（fail-closed），直接以退出码 3 结束。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = "confluence-catalog.json";
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
// 凭据：只从 --cookie-file / --cookie / 环境变量读
// ---------------------------------------------------------------------------
function readCookie() {
  if (typeof args["cookie-file"] === "string" && args["cookie-file"]) {
    return readFileSync(args["cookie-file"], "utf8").trim();
  }
  if (typeof args.cookie === "string" && args.cookie) return args.cookie.trim();
  if (process.env.CONFLUENCE_COOKIE) return process.env.CONFLUENCE_COOKIE.trim();
  return "";
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

/** 必填参数还停在目录占位符上 → 校验不过，零网络请求。 */
function missingRequired(entry, params) {
  if (!entry) return [];
  const missing = [];
  for (const p of entry.paramDetail ?? []) {
    if (!p.required) continue;
    const value = params[p.name];
    if (value === undefined || value === null || value === "" || (typeof value === "string" && value.startsWith("<"))) {
      missing.push(p.name);
    }
  }
  return missing;
}

const host = typeof args.host === "string" ? args.host : (SITE.apiHosts ?? [])[0];
if (!host) fail("目录里没有 site.apiHosts，也没有传 --host", 2);
const origin = typeof args.origin === "string" ? args.origin : (SITE.pageOrigin ? `https://${SITE.pageOrigin}` : "");
const cookie = readCookie();
if (!cookie) fail("缺少凭据：用 --cookie-file <path>、--cookie <str> 或环境变量 CONFLUENCE_COOKIE 提供 JSESSIONID 会话 cookie。", 2);

function requestHeaders(entry) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
  };
  const encoding = entry?.bodyEncoding ?? "json";
  if (!entry || entry.method === "GET" || entry.method === "HEAD") {
    headers.Accept = "application/json, text/plain, */*";
  } else if (encoding === "form") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else {
    headers["Content-Type"] = "application/json";
  }
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/confluence/`;
  }
  headers.Cookie = cookie;
  return headers;
}

/** REST 型：path 占位替换 + query/body 拆分。 */
function buildRequest(entry, params) {
  const method = (entry?.method ?? "GET").toUpperCase();
  const template = entry?.path ?? TRANSPORT.endpoint ?? "/";
  const path = template.replace(/\{(\w+)\}/g, (_m, key) => encodeURIComponent(String(params[key] ?? "")));
  const query = new URLSearchParams();
  const bodyObj = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") bodyObj[key] = value;
    else query.set(key, String(value));
  }
  // path 里的占位参数不该再进 query
  for (const p of entry?.paramDetail ?? []) {
    if (p.location === "path") query.delete(p.name);
  }
  const qs = query.toString();
  const url = `https://${host}${path}${qs ? `?${qs}` : ""}`;
  let body;
  if (method === "GET" || method === "HEAD") {
    body = undefined;
  } else {
    const encoding = entry?.bodyEncoding ?? "json";
    if (encoding === "multipart") {
      fail(`条目 ${entry.id} 需要 multipart 请求体，本客户端不手工构造 multipart（--params-file 只覆盖参数、不改编码）；请改用本仓 call_api_command（扩展侧构造 multipart）`, 2);
    }
    if (encoding === "form") {
      body = new URLSearchParams(Object.entries(bodyObj).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
    } else {
      body = JSON.stringify(bodyObj);
    }
  }
  return { url, method, body };
}

async function send(url, method, body, headers) {
  const resp = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual" });
  if (resp.status >= 300 && resp.status < 400) {
    return { http: resp.status, redirect: resp.headers.get("location") || "(无 Location)", redirected: true };
  }
  const text = await resp.text();
  const contentType = resp.headers.get("content-type") ?? "";
  let parsed = text;
  if (contentType.includes("json")) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { http: resp.status, contentType, body: parsed };
}

function pick(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}

/** 单条目执行；返回 {ok, ...}。校验类错误直接退出码 2（零网络请求）。 */
async function runOne(id) {
  const entry = entryById(id);
  if (!entry) {
    if (args.strict === true) fail(`目录里没有条目 ${id}（去掉 --strict 可强行调用）`, 2);
    fail(`目录里没有条目 ${id}；本客户端只驱动目录内的端点（去掉 --strict 也不会凭空造端点）`, 2);
  }
  if (entry.risk === "write" && args["confirm-write"] !== true) {
    fail(`条目 ${id} 是写操作（risk=write），默认拒发；确认副作用后再加 --confirm-write`, 2);
  }
  const params = buildParams(id);
  const missing = missingRequired(entry, params);
  if (missing.length) {
    fail(`条目 ${id} 缺少必填参数：${missing.join(", ")}（用 --set k=v 或 --params 覆盖）`, 2);
  }
  const request = buildRequest(entry, params);
  const result = await send(request.url, request.method, request.body, requestHeaders(entry));
  return { id, entry, request, result };
}

function report(result, exitOnFail) {
  const { id, entry, request, result: r } = result;
  const ok = r.http >= 200 && r.http < 300;
  process.stdout.write(`\n=== ${id} → ${request.method} ${request.url} ===\n`);
  if (r.redirected) {
    process.stdout.write(`HTTP ${r.http} 被重定向到 ${r.redirect}（不跟随）\n`);
  } else {
    process.stdout.write(`HTTP ${r.http}${r.contentType ? ` ${r.contentType}` : ""}\n`);
  }
  if (r.body !== undefined) {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
    if (typeof args.pick === "string") {
      process.stdout.write(`${JSON.stringify(pick(r.body, args.pick), null, 2)}\n`);
    } else if (args.raw === true) {
      process.stdout.write(`${text.slice(0, 20000)}\n`);
    } else {
      process.stdout.write(`${text.slice(0, 5000)}\n`);
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 批量：REST 站点无网关批量，逐条独立结算（一个失败不拖垮其余）
// ---------------------------------------------------------------------------
const multi = typeof args.multi === "string" ? args.multi.split(",").map((s) => s.trim()).filter(Boolean) : [];
if (multi.length > 0) {
  const results = [];
  let failed = 0;
  for (const id of multi) {
    const result = await runOne(id);
    const ok = report(result, false);
    if (!ok) failed += 1;
    results.push({ id, http: result.result.http, ok });
  }
  process.stdout.write(`\n批量结果：${results.map((r) => `${r.id}=${r.ok ? "success" : `fail(${r.http})`}`).join(", ")}\n`);
  process.exit(failed === 0 ? 0 : 4);
}

// ---------------------------------------------------------------------------
// 单条目
// ---------------------------------------------------------------------------
const id = typeof args.action === "string" ? args.action : "";
if (!id) fail("用法: node confluence-api.mjs --action <Id> [--multi A,B,C] [--list]", 2);
const single = await runOne(id);
const ok = report(single, true);
if (single.result.redirected) process.exit(3);
process.exit(ok ? 0 : 4);
