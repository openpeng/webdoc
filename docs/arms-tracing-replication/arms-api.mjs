#!/usr/bin/env node
/**
 * ARMS Tracing「无 UI」API 客户端。
 *
 * 复刻对象：阿里云应用实时监控服务（ARMS）应用监控控制台
 *   https://armsnext.console.aliyun.com/tracing#/tracing/<region>?appId=<pid>
 *
 * 逆向结论摘要（完整版见 docs/arms-tracing-replication-report.md）：
 *   1. 业务接口全部收敛到一个 RPC 网关：
 *        POST https://fecs.console.aliyun.com/data/api.json?<ActionName>
 *      动作名在 query，参数在 form body 的 `params` 字段里（URL 编码的 JSON 字符串）。
 *   2. body 固定形态：product=arms&action=<Action>&region=<Region>&params=<JSON>
 *   3. 批量形态：POST /data/v2/multiApi.json?<A1>~<A2>... ，
 *      body 为 product=arms&actions=[{action,params},...]
 *   4. 鉴权需要**同时**满足两件事（实测 A/B/C/D 对照）：
 *        - Cookie: login_aliyunid_ticket 等会话 cookie（SameSite=Lax）
 *        - Origin / Referer 指向阿里云控制台域名
 *      缺 cookie → ConsoleNeedLogin；缺 origin → 403 Forbidden。
 *
 * Cookie 来源：--cookie-file，或环境变量 ARMS_COOKIE。
 * 浏览器导出：WebPilot 的 browser_cookie(action=get_all) → 拼成 "k=v; k=v" 一行，
 *              只保留 .aliyun.com 域下的会话 cookie（login_aliyunid* / login_current_pk /
 *              cna / aliyun_lang / aliyun_site / isg）。
 *
 * 示例：
 *   node arms-api.mjs --action GetTraceApp --from-catalog --set Pid=<appId>
 *   node arms-api.mjs --multi GetTraceApp,GetUserInfo --from-catalog
 *   node arms-api.mjs --action GetTraceAggr --params-file params.json
 *   node arms-api.mjs --list
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, "arms-catalog.json");
const DEFAULT_HOST = "fecs.console.aliyun.com";
const DEFAULT_REGION = "cn-hangzhou";
const DEFAULT_ORIGIN = "https://armsnext.console.aliyun.com";

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
const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));

function readCookie() {
  if (typeof args["cookie-file"] === "string" && args["cookie-file"]) {
    return readFileSync(args["cookie-file"], "utf8").trim();
  }
  if (typeof args.cookie === "string" && args.cookie) return args.cookie.trim();
  if (process.env.ARMS_COOKIE) return process.env.ARMS_COOKIE.trim();
  return "";
}

function catalogEntry(action) {
  return catalog.entries.find((item) => item.id === action);
}

/** 目录里记录的参数形态作为基底（需显式 --from-catalog），再叠加调用方的覆盖值。 */
function buildParams(action) {
  let params = {};
  const entry = catalogEntry(action);
  if (args["from-catalog"] === true && entry && entry.params) {
    params = JSON.parse(JSON.stringify(entry.params));
  }
  const paramsText = (typeof args["params-file"] === "string" && args["params-file"])
    ? readFileSync(args["params-file"], "utf8")
    : (typeof args.params === "string" ? args.params : "");
  if (paramsText.trim()) {
    try { params = { ...params, ...JSON.parse(paramsText) }; }
    catch (err) { fail(`--params 不是合法 JSON: ${err.message}`); }
  }
  for (const pair of args.set) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const region = typeof args.region === "string" ? args.region : DEFAULT_REGION;
  if (!params.RegionId) params.RegionId = region;
  if (!params.aliyunLang) params.aliyunLang = typeof args.lang === "string" ? args.lang : "zh";
  return params;
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (args.list === true) {
  const groups = new Map();
  for (const item of catalog.entries) {
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
  process.stdout.write(`\n合计 ${catalog.entries.length} 个动作 / ${groups.size} 个资源域；✔=observed  ~=derived  ?=unknown\n`);
  process.exit(0);
}

const cookie = readCookie();
if (!cookie) {
  fail("缺少 Cookie。用 --cookie-file <path> 或环境变量 ARMS_COOKIE 提供会话 cookie。", 2);
}

const region = typeof args.region === "string" ? args.region : DEFAULT_REGION;
const host = typeof args.host === "string" ? args.host : DEFAULT_HOST;
const origin = typeof args.origin === "string" ? args.origin : DEFAULT_ORIGIN;

function headers() {
  const h = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    Origin: origin,
    Referer: `${origin}/tracing`,
    Cookie: cookie,
  };
  if (typeof args.referer === "string") h.Referer = args.referer;
  return h;
}

async function send(url, body) {
  const resp = await fetch(url, { method: "POST", headers: headers(), body, redirect: "manual" });
  if (resp.status >= 300 && resp.status < 400) {
    fail(`HTTP ${resp.status} 被重定向到 ${resp.headers.get("location") || "(无 Location)"} —— 会话 cookie 可能已过期`, 3);
  }
  const text = await resp.text();
  try { return { http: resp.status, ...JSON.parse(text) }; }
  catch { return { http: resp.status, code: "nonJSON", message: text.slice(0, 200) }; }
}

/** data.Data 常是二次编码的 JSON 字符串，展开一层更方便看。 */
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
  const parts = String(path).split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur;
}

const multi = typeof args.multi === "string" ? args.multi.split(",").map((s) => s.trim()).filter(Boolean) : [];

if (multi.length > 0) {
  const actions = multi.map((action) => ({ action, params: buildParams(action) }));
  const batchPath = catalog.transport?.batch?.endpoint ?? "/data/v2/multiApi.json";
  const url = `https://${host}${batchPath}?${encodeURIComponent(actions.map((a) => a.action).join("~"))}`;
  const body = new URLSearchParams({ product: catalog.transport?.product ?? "arms", actions: JSON.stringify(actions) }).toString();
  const result = unwrap(await send(url, body));
  const data = result.data || {};
  for (const [index, item] of Object.entries(data)) {
    const name = actions[Number(index)]?.action ?? index;
    process.stdout.write(`\n=== [${index}] ${name} success=${item.success} code=${item.code} ===\n`);
    const inner = item.data && typeof item.data.Data === "string"
      ? { ...item.data, Data: safeParse(item.data.Data) } : item.data;
    process.stdout.write(`${JSON.stringify(inner, null, 2)}\n`);
  }
  process.exit(result.code === "200" ? 0 : 4);
}

const action = typeof args.action === "string" ? args.action : "";
if (!action) fail("用法: node arms-api.mjs --action <ActionName> [--multi A,B,C] [--list]", 2);
if (!catalogEntry(action) && args.strict === true) {
  fail(`目录里没有动作 ${action}（去掉 --strict 可强行调用）`, 2);
}

const params = buildParams(action);
const endpoint = catalog.transport?.endpoint ?? "/data/api.json";
const url = `https://${host}${endpoint}?${encodeURIComponent(action)}`;
const body = new URLSearchParams({ product: catalog.transport?.product ?? "arms", action, region, params: JSON.stringify(params) }).toString();
const result = unwrap(await send(url, body));

if (args.raw === true) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (typeof args.pick === "string") {
  process.stdout.write(`${JSON.stringify(pick(result, args.pick), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
process.exit(result.code === "200" ? 0 : 4);

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}
