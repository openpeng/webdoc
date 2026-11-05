// SiteScan 静态推导通道测试：全部导入 ../dist/*.js 编译产物。
// 覆盖：四类数据源解析、路径归一、参数推断、URL 安全（SSRF）、编排层零扩展依赖、
//       风险保守、缓存落盘重载、敏感值不泄漏。不修改任何现有测试文件。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanJsText, parseOpenApiText, parseHarText, parseCommandSetText,
  scanSources, toScanRecords, checkScanUrl, isPrivateHost, isSpecOrigin,
} from "../dist/api-command-site-scan.js";
import { groupEndpoints, endpointKey } from "../dist/api-command-normalize.js";
import { generateCommands } from "../dist/api-command-generator.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import {
  SITE_SCAN_REVIEW_REASON, SITE_SCAN_PRIVATE_HOST_WARNING,
  SITE_SCAN_CROSS_HOST_WARNING, SITE_SCAN_NO_SOURCE_WARNING,
  SITE_SCAN_CONSERVATIVE_RISK_WARNING, SITE_SCAN_CROSS_HOST_COMMAND_WARNING,
} from "../dist/api-command-types.js";

const JS_BUNDLE = `
const API = '/api/v1';
fetch('/api/v1/courses?page=1&size=20');
axios.get('/api/v1/users/' + id + '/profile');
axios.post('/api/v1/courses/search', { page: 1, size: 20 });
fetch(\`/api/v1/orders/\${orderId}/items\`);
fetch('/static/app.js');
fetch('/api/v1/track');
`;

const OPENAPI = JSON.stringify({
  paths: {
    "/api/v1/courses": {
      get: { parameters: [{ name: "page", in: "query" }, { name: "size", in: "query" }] },
      post: { requestBody: { content: { "application/json": { schema: { properties: { title: {}, category: {} } } } } } },
    },
    "/api/v1/courses/{id}": { delete: { parameters: [{ name: "id", in: "path" }] } },
  },
});

const HAR = JSON.stringify({
  log: {
    entries: [
      { request: { url: "https://example.com/courses/list?page=2", method: "POST", postData: { params: [{ name: "keyword" }, { name: "size" }] } } },
      { request: { url: "https://example.com/logo.png", method: "GET" } },
    ],
  },
});

const COMMAND_SET = JSON.stringify({
  commands: [
    { name: "list.orders", method: "GET", path: "/api/v1/orders", params: [{ name: "page", location: "query" }] },
  ],
});

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-scan-"));
  try {
    const file = join(dir, "api-commands.json");
    return await fn(new ApiCommandCache(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 四类数据源解析
// ---------------------------------------------------------------------------

test("scanJsText 抽取 API 路径并过滤静态资源与埋点", () => {
  const candidates = scanJsText(JS_BUNDLE);
  assert.ok(candidates.length >= 3, `实际 ${candidates.length} 条`);
  assert.ok(candidates.some((c) => c.pathTemplate.includes("courses")));
  assert.ok(!candidates.some((c) => c.pathTemplate.includes("app.js")));
  assert.ok(!candidates.some((c) => c.pathTemplate.includes("track")));
  assert.ok(candidates.some((c) => c.method === "POST"), "应识别 axios.post 的真实 method");
  assert.ok(candidates.some((c) => c.pathTemplate.includes("{id}")), "模板字符串应归一为 {id}");
});

test("scanJsText 不把样本值或敏感字段名带入产物", () => {
  const text = `
    fetch('/api/v1/orders?token=abc123SECRET&page=1');
    axios.post('/api/v1/login', { password: 'hunter2', csrf_token: 'xyz', username: 'alice' });
    fetch('https://cdn.example.com/api/v1/ping');
  `;
  const serialized = JSON.stringify(scanJsText(text));
  for (const needle of ["abc123SECRET", "hunter2", "xyz", "alice", "Bearer"]) {
    assert.ok(!serialized.includes(needle), `泄漏敏感值: ${needle}`);
  }
  const login = scanJsText(text).find((c) => c.pathTemplate.includes("login"));
  assert.ok(login);
  assert.ok(!login.bodyNames.includes("password"));
  assert.ok(!login.bodyNames.includes("csrf_token"));
});

test("parseOpenApiText 保留 {id} 结构并区分 query / body 参数", () => {
  const candidates = parseOpenApiText(OPENAPI);
  assert.equal(candidates.length, 3);
  const get = candidates.find((c) => c.method === "GET");
  const post = candidates.find((c) => c.method === "POST");
  const del = candidates.find((c) => c.method === "DELETE");
  assert.deepEqual(get.queryNames.sort(), ["page", "size"]);
  assert.deepEqual(post.bodyNames.sort(), ["category", "title"]);
  assert.ok(del.pathTemplate.includes("{id}"), `实际 ${del.pathTemplate}`);
  assert.ok(candidates.every((c) => c.origin === "openapi"));
});

test("parseHarText 只保留 API 记录并丢弃取值", () => {
  const candidates = parseHarText(HAR);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].method, "POST");
  assert.deepEqual(candidates[0].queryNames, ["page"]);
  assert.deepEqual(candidates[0].bodyNames.sort(), ["keyword", "size"]);
  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes("page=2"));
  assert.ok(!serialized.includes("example.com"));
});

test("parseCommandSetText 读取本地声明式命令包", () => {
  const candidates = parseCommandSetText(COMMAND_SET);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].method, "GET");
  assert.equal(candidates[0].pathTemplate, "/api/v1/orders");
  assert.deepEqual(candidates[0].queryNames, ["page"]);
  assert.equal(candidates[0].origin, "commands");
});

test("四类解析器对空输入 / 非法 JSON / 超大文本均 fail-closed", () => {
  assert.deepEqual(scanJsText(""), []);
  assert.deepEqual(parseOpenApiText("not json"), []);
  assert.deepEqual(parseHarText("{"), []);
  assert.deepEqual(parseCommandSetText("[]"), []);
  assert.deepEqual(parseOpenApiText("{}"), []);
  const huge = `fetch('/api/v1/a');`.repeat(200000);
  assert.ok(scanJsText(huge).length <= 200);
});

// ---------------------------------------------------------------------------
// 2. 统一扫描、记录适配与生成管线
// ---------------------------------------------------------------------------

test("scanSources 合并四源去重、限额并统计 sourcesRead", () => {
  const result = scanSources([
    { kind: "js", text: JS_BUNDLE },
    { kind: "openapi", text: OPENAPI },
    { kind: "har", text: HAR },
    { kind: "commands", text: COMMAND_SET },
    { kind: "js", text: "" },
  ], { domain: "example.com", maxEndpoints: 50 });
  assert.ok(result.candidates.length >= 5);
  assert.equal(result.sourcesRead, 4);
  assert.ok(result.bytesRead > 0);
  const keys = result.candidates.map((c) => `${c.method}\u0000${c.pathTemplate}`);
  assert.equal(new Set(keys).size, keys.length, "候选必须按 method+pathTemplate 去重");
  assert.ok(result.warnings.length > 0, "空源应给固定 warning");
});

test("scanSources 遵守 maxEndpoints 与源数上限", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ kind: "openapi", text: JSON.stringify({ paths: { [`/api/v1/r${i}`]: { get: {} } } }) }));
  const result = scanSources(many, { domain: "example.com", maxEndpoints: 5 });
  assert.equal(result.candidates.length, 5);
  assert.ok(result.sourcesRead <= 40);
});

test("toScanRecords 生成双变体记录，参数被识别为变化字段而非常量", () => {
  const candidates = parseOpenApiText(OPENAPI);
  const records = toScanRecords(candidates, "example.com");
  assert.equal(records.length, candidates.length * 2);
  const getRecords = records.filter((r) => r.method === "GET" && r.path.includes("courses"));
  assert.equal(getRecords[0].queryPairs[0].value, "1");
  assert.equal(getRecords[1].queryPairs[0].value, "2");
  const groups = groupEndpoints(records);
  assert.equal(groups.length, candidates.length);
  const key = endpointKey("GET", "/api/v1/courses");
  assert.ok(groups.some((g) => endpointKey(g.method, g.pathTemplate) === key));
});

test("生成物通过缓存白名单重建，且强制空 schema / needsReview", async () => {
  const scanned = scanSources([{ kind: "openapi", text: OPENAPI }], { domain: "example.com" });
  const groups = groupEndpoints(toScanRecords(scanned.candidates, "example.com"));
  const generated = generateCommands(groups, {
    domain: "example.com", analysisId: "an_scan_test", generatedBy: "1.1.1",
    schema: new Map(), now: new Date().toISOString(),
    forceNeedsReview: true, emptyResponseSchema: true,
  });
  assert.ok(generated.commands.length > 0);
  assert.ok(generated.commands.every((c) => c.responseSchema.fields.length === 0));
  assert.ok(generated.needsReview.length > 0);
  await withCache(async (cache) => {
    await cache.merge("example.com", generated.commands, { mode: "merge" });
    const listed = await cache.list("example.com");
    assert.equal(listed.commands.length, generated.commands.length);
  });
});

// ---------------------------------------------------------------------------
// 3. URL 安全（SSRF 防护）与放开开关
// ---------------------------------------------------------------------------

test("isPrivateHost 识别回环 / 内网 / 链路本地 / 内网后缀", () => {
  for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "::1", "svc.internal", "x.local", ""]) {
    assert.equal(isPrivateHost(host), true, `应判为私网: ${host}`);
  }
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(isPrivateHost("cdn.example.org"), false);
});

test("checkScanUrl 默认拒绝非 http(s)、内嵌凭据、跨 host、私网", () => {
  const policy = { domain: "example.com" };
  for (const url of [
    "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/a.js",
    "https://user:pw@example.com/a.js", "http://127.0.0.1/a.js",
    "http://localhost/a.js", "http://10.0.0.5/a.js",
  ]) {
    assert.equal(checkScanUrl(url, policy).ok, false, `应拒绝: ${url}`);
  }
  assert.equal(checkScanUrl("https://cdn.other.com/a.js", policy).ok, false);
  assert.equal(checkScanUrl("https://cdn.other.com/a.js", policy).reason, SITE_SCAN_CROSS_HOST_WARNING);
  assert.equal(checkScanUrl("https://example.com/app.js", policy).ok, true);
  assert.ok(!JSON.stringify(checkScanUrl("https://user:pw@example.com/a.js", policy)).includes("pw"));
});

test("黄区开关必须显式开启且跨 host 需同时列 extraHosts", () => {
  // 私网 + 跨 host：即便放开私网，仍受同源策略约束。
  assert.equal(checkScanUrl("http://10.0.0.5/a.js", { domain: "example.com", allowPrivateHosts: true }).ok, false);
  // domain 本身是私网时，显式放开才可读。
  assert.equal(checkScanUrl("http://10.0.0.5/a.js", { domain: "10.0.0.5", allowPrivateHosts: true }).ok, true);
  assert.equal(checkScanUrl("https://cdn.other.com/a.js", { domain: "example.com", allowCrossHost: true }).ok, false);
  assert.equal(checkScanUrl("https://cdn.other.com/a.js", {
    domain: "example.com", allowCrossHost: true, extraHosts: ["cdn.other.com"],
  }).ok, true);
  assert.equal(checkScanUrl("http://10.0.0.5/a.js", { domain: "example.com", allowPrivateHosts: false }).reason, SITE_SCAN_PRIVATE_HOST_WARNING);
});

// ---------------------------------------------------------------------------
// 4. 编排层：零扩展依赖、风险保守、缓存落盘
// ---------------------------------------------------------------------------

test("ApiCommandService.scanSite 完全不依赖扩展消息", async () => {
  await withCache(async (cache) => {
    let calls = 0;
    const explodingSend = async () => { calls += 1; throw new Error("扩展不可用（预期：不应被调用）"); };
    const service = new ApiCommandService(cache, explodingSend);
    const report = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "openapi", text: OPENAPI }],
    });
    assert.equal(calls, 0, "scan_site 不应发送任何扩展消息");
    assert.ok(report.commandCount > 0);
    assert.ok(report.cacheWritten);
    assert.equal(report.sampledResponseCount, 0);
    assert.ok(report.needsReview.every((item) => typeof item.reason === "string"));
    assert.ok(report.needsReview.some((item) => item.reason === SITE_SCAN_REVIEW_REASON));
  });
});

test("scan_site 默认按 method 判定 risk；trustSpec=false 才回退全量 write 保守模式", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const trusted = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "openapi", text: OPENAPI }],
    });
    assert.ok(!trusted.warnings.includes(SITE_SCAN_CONSERVATIVE_RISK_WARNING));
    const listed = await cache.list("example.com", { includeDisabled: true });
    assert.ok(listed.commands.length > 0);
    assert.ok(listed.commands.some((card) => card.risk === "read"), "默认下 GET 应为 read");
  });
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const conservative = await service.analyze({
      action: "scan_site", domain: "example.com", trustSpec: false,
      sources: [{ kind: "openapi", text: OPENAPI }],
    });
    assert.ok(conservative.warnings.includes(SITE_SCAN_CONSERVATIVE_RISK_WARNING));
    const listed = await cache.list("example.com", { includeDisabled: true });
    assert.ok(listed.commands.every((card) => card.risk === "write"), "trustSpec=false 必须全部 write");
  });
});

test("scan_site 落盘后新实例可加载，且不写响应体样本 / 敏感值", async () => {
  await withCache(async (cache, file) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", text: JS_BUNDLE }, { kind: "har", text: HAR }],
    });
    assert.ok(report.commandCount > 0);
    const reloaded = new ApiCommandCache(file);
    const listed = await reloaded.list("example.com");
    assert.equal(listed.commands.length, report.commandCount);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(file, "utf8");
    for (const needle of ["abc123", "hunter2", "Bearer", "csrf"]) {
      assert.ok(!raw.includes(needle), `缓存落盘泄漏: ${needle}`);
    }
  });
});

test("scan_site 边界：无 domain / 无源 / 非法 kind / 私网 URL 被跳过", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const noDomain = await service.analyze({ action: "scan_site", sources: [{ kind: "js", text: JS_BUNDLE }] });
    assert.equal(noDomain.commandCount, 0);
    assert.ok(noDomain.warnings.some((w) => w.includes("domain")));

    const noSource = await service.analyze({ action: "scan_site", domain: "example.com" });
    assert.equal(noSource.commandCount, 0);
    assert.ok(noSource.warnings.includes(SITE_SCAN_NO_SOURCE_WARNING));

    const badKind = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "evil", text: JS_BUNDLE }],
    });
    assert.equal(badKind.commandCount, 0);

    const privateUrl = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", url: "http://127.0.0.1/app.js" }],
    });
    assert.equal(privateUrl.commandCount, 0);
    assert.ok(privateUrl.warnings.includes(SITE_SCAN_PRIVATE_HOST_WARNING));

    const crossHost = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", url: "https://cdn.other.com/app.js" }],
    });
    assert.equal(crossHost.commandCount, 0);
    assert.ok(crossHost.warnings.includes(SITE_SCAN_CROSS_HOST_WARNING));
  });
});

test("scan_site 的 url 源走真实 HTTP 读取（本地回环需显式放行）", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(JS_BUNDLE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await withCache(async (cache) => {
      const service = new ApiCommandService(cache, async () => { throw new Error("不应调用扩展"); });
      const blocked = await service.analyze({
        action: "scan_site", domain: "example.com",
        sources: [{ kind: "js", url: `http://127.0.0.1:${port}/app.js` }],
      });
      assert.equal(blocked.commandCount, 0, "默认应拒绝私网地址");

      const allowed = await service.analyze({
        action: "scan_site", domain: "127.0.0.1", allowPrivateHosts: true,
        sources: [{ kind: "js", url: `http://127.0.0.1:${port}/app.js` }],
      });
      assert.ok(allowed.commandCount > 0, "显式放行后应真实拉取并生成命令");
      assert.equal(allowed.sampledResponseCount, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("isSpecOrigin 只把 openapi / commands 视为权威规格", () => {
  assert.equal(isSpecOrigin("openapi"), true);
  assert.equal(isSpecOrigin("commands"), true);
  assert.equal(isSpecOrigin("js"), false);
  assert.equal(isSpecOrigin("har"), false);
});

// ===== 回归：JS 模板插值 ${...} 不得被当成 OpenAPI 参数（真实站点实测发现） =====

test("`/${id}` 纯字面量占位：全动态段被丢弃，不产出含 $ 的脏模板", () => {
  // 真实来源：nextjs.org chunk 里存在字面量 "/${id}"，曾产出 /$123456789。
  const found = scanJsText('const p = "/${id}"; use(p);');
  assert.equal(found.length, 0, "全动态段没有任何静态锚点，应整体丢弃");
});

test("`/api/v1/${userId}/detail` 归一为 /api/v1/{id}/detail，且不含 $", () => {
  const found = scanJsText('fetch("/api/v1/${userId}/detail");');
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/api/v1/{id}/detail");
  assert.ok(!found[0].pathTemplate.includes("$"), "不得残留模板插值符");
});

test("`${...}` 中的 {name} 不再被 OPENAPI_PARAM_RE 抢先匹配", () => {
  // 若正则未排除 `${`，会得到 `/${id}`：$ 残留 + {id} 被替换 → 归一失败。
  const found = scanJsText('axios.get("/api/orders/${orderId}");');
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/api/orders/{id}");
});

test("同一模板的双变体记录最终归并为 1 条命令（不再重复计数）", () => {
  const candidates = scanJsText('axios.get("/api/v1/${orderId}");');
  assert.equal(candidates.length, 1);
  const records = toScanRecords(candidates, "example.com");
  assert.equal(records.length, 2, "toScanRecords 恒产两条变体记录");
  const grouped = groupEndpoints(records);
  assert.equal(grouped.length, 1, "两条变体必须归并为同一端点");
  assert.equal(grouped[0].pathTemplate, "/api/v1/{id}");
  const raw = JSON.stringify(grouped);
  assert.ok(!raw.includes("$123456789"), "占位数字不得进入模板");
});

test("OpenAPI 风格 {petId} 仍正常归一（静态锚点保留）", () => {
  const api = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/pet/{petId}": { get: { operationId: "getPetById" } } },
  });
  const found = parseOpenApiText(api);
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/pet/{id}");
  assert.equal(found[0].method, "GET");
});

test("归一兜底：残留花括号 / 反引号的模板一律丢弃", () => {
  for (const bad of ['"/api/v1/${",', '"/api/`x`/list",', '"/api/{unclosed/list",']) {
    const found = scanJsText(`var a = ${bad} b(a);`);
    for (const item of found) {
      assert.ok(!/[$`]/.test(item.pathTemplate), `残留模板语法: ${item.pathTemplate}`);
      assert.ok(!/\{[^}]*$/.test(item.pathTemplate), `未闭合花括号: ${item.pathTemplate}`);
    }
  }
});

// ===== 回归：OpenAPI 的 servers / basePath 前缀（真实执行发现 404） =====

test("OpenAPI 3 servers[].url 的 path 前缀必须拼到每条命令上", () => {
  // 真实事故：petstore 的 /pet/findByStatus 实际在 /api/v3/pet/findByStatus，
  // 漏前缀后命令 URL 全部 404（端到端执行实测发现）。
  const spec = JSON.stringify({
    openapi: "3.0.0",
    servers: [{ url: "https://petstore3.swagger.io/api/v3" }],
    paths: { "/pet/findByStatus": { get: {} }, "/pet/{petId}": { get: {} } },
  });
  const found = parseOpenApiText(spec);
  assert.deepEqual(found.map((c) => c.pathTemplate).sort(),
    ["/api/v3/pet/findByStatus", "/api/v3/pet/{id}"]);
});

test("Swagger 2.0 basePath 同样生效", () => {
  const spec = JSON.stringify({ swagger: "2.0", basePath: "/v2/api", paths: { "/users": { get: {} } } });
  assert.deepEqual(parseOpenApiText(spec).map((c) => c.pathTemplate), ["/v2/api/users"]);
});

test("无 servers / basePath 时保持原路径，不凭空加前缀", () => {
  const spec = JSON.stringify({ openapi: "3.0.0", paths: { "/health": { get: {} } } });
  assert.deepEqual(parseOpenApiText(spec).map((c) => c.pathTemplate), ["/health"]);
});

test("paths 已含前缀时不重复拼接", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0", servers: [{ url: "/api/v3" }], paths: { "/api/v3/pet": { get: {} } },
  });
  assert.deepEqual(parseOpenApiText(spec).map((c) => c.pathTemplate), ["/api/v3/pet"]);
});

test("servers 含 {变量} 时放弃拼前缀，不猜值", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0", servers: [{ url: "https://{env}.example.com/v1" }], paths: { "/pet": { get: {} } },
  });
  assert.deepEqual(parseOpenApiText(spec).map((c) => c.pathTemplate), ["/pet"]);
});

test("端到端：带 servers 的规格生成命令，urlTemplate 含完整前缀", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0",
    servers: [{ url: "https://petstore3.swagger.io/api/v3" }],
    paths: { "/pet/findByStatus": { get: { parameters: [{ name: "status", in: "query" }] } } },
  });
  const scanned = scanSources([{ kind: "openapi", text: spec }], { domain: "petstore3.swagger.io" });
  const groups = groupEndpoints(toScanRecords(scanned.candidates, "petstore3.swagger.io"));
  const generated = generateCommands(groups, {
    domain: "petstore3.swagger.io", analysisId: "an_scan_test", generatedBy: "1.1.1",
    schema: new Map(), now: new Date().toISOString(),
    forceNeedsReview: true, emptyResponseSchema: true,
  });
  assert.equal(generated.commands.length, 1);
  assert.equal(
    generated.commands[0].request.urlTemplate,
    "https://petstore3.swagger.io/api/v3/pet/findByStatus?status={{status}}",
  );
});

// ---------------------------------------------------------------------------
// T1 静态推导放开（AC-1 / AC-2）
// ---------------------------------------------------------------------------

// 现代站点常见的「短前缀 + 1 段」路径：既不匹配高置信前缀，也不满足「≥3 段」规则。
const MODERN_BUNDLE = `
const nav = '/x/nav';
const items = '/pgc/items';
fetch('/x/web-interface/nav');
axios.post('/x/vip/ads/materials', { id: 1 });
`;

test("T1：loosePaths 默认放开 —— 2 段短前缀路径也能发现端点（保守模式下为 0）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const relaxed = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", text: MODERN_BUNDLE }],
    });
    assert.ok(relaxed.endpointCount >= 2, `默认应发现现代站点端点，实际 ${relaxed.endpointCount}`);
    assert.ok(
      relaxed.commands.some((card) => card.pathTemplate === "/x/nav"),
      "应发现 /x/nav 这类短前缀路径",
    );
  });
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const strict = await service.analyze({
      action: "scan_site", domain: "example.com", loosePaths: false,
      sources: [{ kind: "js", text: MODERN_BUNDLE }],
    });
    assert.equal(strict.endpointCount, 0, "loosePaths=false 必须回到保守模式（产出 0）");
  });
});

test("T1：静态推导 risk 按 method 判定（GET→read，其余→write）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", text: MODERN_BUNDLE }],
    });
    const listed = await cache.list("example.com", { includeDisabled: true });
    const get = listed.commands.find((card) => card.pathTemplate === "/x/nav");
    const post = listed.commands.find((card) => card.pathTemplate === "/x/vip/ads/materials");
    assert.equal(get?.risk, "read", "GET 应为 read");
    assert.equal(post?.risk, "write", "POST 应为 write");
    assert.ok(report.commandCount > 0);
  });
});

test("T1：needsReview 降为每条命令 1 条来源标注", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", text: MODERN_BUNDLE }],
    });
    assert.ok(report.needsReview.length > 0);
    assert.equal(
      report.needsReview.length,
      new Set(report.needsReview.map((item) => item.commandId)).size,
      "每条命令只应有 1 条 needsReview",
    );
    assert.ok(report.needsReview.every((item) => item.reason === SITE_SCAN_REVIEW_REASON));
  });
});

test("T1：报告标注输入来源层级 bundleSource", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const inline = await service.analyze({
      action: "scan_site", domain: "example.com",
      sources: [{ kind: "js", text: MODERN_BUNDLE }],
    });
    assert.equal(inline.bundleSource, "inline");

    const none = await service.analyze({ action: "scan_site", domain: "example.com" });
    assert.equal(none.bundleSource, "none");
  });
});

// ---------------------------------------------------------------------------
// T2 路径归一与 method 修复（AC-13）
// ---------------------------------------------------------------------------

test("T2：协议相对 URL 不再被整体当路径，host 被还原", () => {
  const candidates = scanJsText("const u = '//cm.example.com/api/fees/pc';", { loose: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pathTemplate, "/api/fees/pc", "host 不得留在路径里");
  assert.equal(candidates[0].host, "cm.example.com");
});

test("T2：同一路径挂在不同 host 上是两条候选（不互相去重）", () => {
  const candidates = scanJsText(
    "const a = '//a.example.com/x/nav'; const b = '//b.example.com/x/nav';",
    { loose: true },
  );
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.host).sort(), ["a.example.com", "b.example.com"]);
});

test("T2：method 推断不受上一条语句污染（真实 GET 不被误判成 POST）", () => {
  const polluted = scanJsText(
    "axios.post('/api/v1/other');\nfetch('/x/vip/ads/materials');",
    { loose: true },
  );
  const target = polluted.find((c) => c.pathTemplate === "/x/vip/ads/materials");
  assert.ok(target, "应发现 /x/vip/ads/materials");
  assert.equal(target.method, "GET", "上一条语句的 .post( 不得污染本次判定");

  const explicitType = scanJsText("$.ajax({ url: '/x/frontend/finger/spi', type: 'POST' });", { loose: true });
  assert.equal(explicitType[0].method, "POST", "$.ajax 的 type 字段必须被识别");

  const explicitMethod = scanJsText("axios({ url: '/x/a', method: 'POST' });", { loose: true });
  assert.equal(explicitMethod[0].method, "POST", "对象字面量的 method 字段必须被识别");

  const adjacent = scanJsText("axios.post('/x/vip/ads/materials', { id: 1 });", { loose: true });
  assert.equal(adjacent[0].method, "POST", "紧邻的调用动词仍然生效");
});

test("T2：跨 host 命令按各自 host 归档，并打上 crossHost 标记", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site", domain: "api.example.com",
      sources: [{ kind: "js", text: "const a = '//cm.example.com/x/nav';" }],
    });
    assert.equal(report.commandCount, 1);
    const own = await cache.list("api.example.com", { includeDisabled: true });
    assert.equal(own.commands.length, 0, "跨 host 命令不得落进扫描目标域名的桶");
    const cross = await cache.list("cm.example.com", { includeDisabled: true });
    assert.equal(cross.commands.length, 1, "跨 host 命令应归档到它自己的 host");
    assert.ok(report.warnings.includes(SITE_SCAN_CROSS_HOST_COMMAND_WARNING));
  });
});
