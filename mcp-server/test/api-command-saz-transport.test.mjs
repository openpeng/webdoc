// SAZ 传输层纪律 + 召回归档护栏 + coverage 分子口径。
//
// 全部导入 ../dist/*.js 编译产物，可被 node --test 直测（无网络、无浏览器）。
// 覆盖：
//   1. 【硬纪律】SAZ 归档**绝不截断**：base64 被从中间切断 → 解包必失败且静默；
//      因此归档只有「整体放行」或「整体拒绝」两种结局；
//   2. SAZ 按 base64 配额放行（普通文本上限 2MB 会把 base64 从中间切断）；
//   3. 非 SAZ 来源维持原有截断行为（本次改动不得外溢）；
//   4. 召回归档护栏：四类来源的端点候选数与合并总数固定不变（改口径不得动召回）；
//   5. coverage 分子口径 = **端点维度** observed（总档位恒 unknown，不能当分子）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanSources, scanJsText, parseFiddleText,
  parseHarText, parseOpenApiText, parseCommandSetText,
} from "../dist/api-command-site-scan.js";
import { buildCoverage } from "../dist/api-command-evidence.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";
import {
  SITE_SCAN_MAX_TEXT_CHARS,
  SITE_SCAN_MAX_SOURCE_BYTES,
  SITE_SCAN_SAZ_MAX_BASE64_CHARS,
  SITE_SCAN_SOURCE_FAILED_WARNING,
} from "../dist/api-command-types.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** Fiddler raw HTTP 报文（客户端会话文件内容形态）。 */
const RAW_HTTP = [
  "GET https://example.com/api/v1/courses?page=2&size=20 HTTP/1.1",
  "Host: example.com",
  "User-Agent: Fiddler",
  "",
  "",
].join("\n");

/** CRC32（造 ZIP 用；解码器不校验，但填真值更贴近真实归档）。 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 造一个最小 ZIP（store 方式，Fiddler 导出的 .saz 就是 store / deflate 两种）。
 * 目的不是「造一个能解的包」，而是**造一个够大的包** —— 大到 base64 之后
 * 超过普通文本上限（SITE_SCAN_MAX_TEXT_CHARS），从而验证「不截断」这条纪律。
 */
function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);            // method = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);   // compressed size
    local.writeUInt32LE(raw.length, 22);   // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, raw);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);              // method = store
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(raw.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centralChunks.push(cd, nameBuf);
    offset += local.length + nameBuf.length + raw.length;
  }
  const cdBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

/** 造一份「大」SAZ：真实会话 + 大量填充，使 base64 长度越过普通文本上限。 */
function buildBigSazBase64() {
  const filler = "x".repeat(79).concat("\n").repeat(20000); // ~1.6MB
  const zip = buildZip([
    ["_index.htm", "<html><body>sessions</body></html>"],
    ["raw/1_c.txt", RAW_HTTP],
    ["meta/filler.txt", filler],
  ]);
  return zip.toString("base64");
}

const BIG_SAZ_BASE64 = buildBigSazBase64();

/** 召回归档夹具（与仓库 site-scan 用例同源，保证可比）。 */
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
const RECALL_FIXTURES = [
  { kind: "js", text: JS_BUNDLE },
  { kind: "openapi", text: OPENAPI },
  { kind: "har", text: HAR },
  { kind: "commands", text: COMMAND_SET },
];

/** 只有一条端点的 HAR（用于 coverage 口径断言）。 */
const HAR_ONE = JSON.stringify({
  log: { entries: [{ request: { url: "https://example.com/api/v1/orders?page=2", method: "GET" } }] },
});

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wp-saz-"));
  const file = join(dir, "api-commands.json");
  try {
    return await fn(new ApiCommandCache(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 夹具自证：大归档确实越过了普通文本上限
// ---------------------------------------------------------------------------

test("夹具自证：大 SAZ 的 base64 越过普通文本上限，但仍在 SAZ 配额内", () => {
  assert.ok(
    BIG_SAZ_BASE64.length > SITE_SCAN_MAX_TEXT_CHARS,
    `夹具必须大于普通文本上限，实际 ${BIG_SAZ_BASE64.length}`,
  );
  assert.ok(
    BIG_SAZ_BASE64.length <= SITE_SCAN_SAZ_MAX_BASE64_CHARS,
    `夹具必须在 SAZ 配额内，实际 ${BIG_SAZ_BASE64.length}`,
  );
});

test("SAZ base64 配额自洽：容得下最大二进制的 base64，且大于普通文本上限", () => {
  assert.ok(SITE_SCAN_SAZ_MAX_BASE64_CHARS >= 4 * Math.ceil(SITE_SCAN_MAX_SOURCE_BYTES / 3));
  assert.ok(SITE_SCAN_SAZ_MAX_BASE64_CHARS > SITE_SCAN_MAX_TEXT_CHARS);
});

// ---------------------------------------------------------------------------
// 2. 硬纪律：SAZ 绝不截断
// ---------------------------------------------------------------------------

test("parseFiddleText：超过普通文本上限的大归档照样解出端点（未被截断）", () => {
  const candidates = parseFiddleText(BIG_SAZ_BASE64);
  assert.equal(candidates.length, 1, `实际 ${JSON.stringify(candidates.map((c) => c.pathTemplate))}`);
  assert.equal(candidates[0].pathTemplate, "/api/v1/courses");
  assert.equal(candidates[0].method, "GET");
  assert.equal(candidates[0].origin, "fiddler_saz");
});

test("反证：半截 base64 必然解不出端点 —— 这正是「必须整体放行」的原因", () => {
  const truncated = BIG_SAZ_BASE64.slice(0, SITE_SCAN_MAX_TEXT_CHARS);
  assert.equal(
    parseFiddleText(truncated).length,
    0,
    "被截断的 base64 应当解不出任何端点（静默失败，故不能截断）",
  );
});

test("scanSources：大归档来源不会被普通文本上限截掉", () => {
  const scanned = scanSources(
    [{ kind: "fiddler_saz", text: BIG_SAZ_BASE64 }],
    { domain: "example.com", maxEndpoints: 50 },
  );
  assert.equal(scanned.candidates.length, 1);
  assert.equal(scanned.candidates[0].pathTemplate, "/api/v1/courses");
  assert.deepEqual((scanned.warnings ?? []).filter((w) => w === SITE_SCAN_SOURCE_FAILED_WARNING), []);
});

test("超配额的 SAZ 整体拒绝（fail-closed），不半截放行", () => {
  const tooBig = "UEsD" + "A".repeat(SITE_SCAN_SAZ_MAX_BASE64_CHARS);
  assert.ok(tooBig.length > SITE_SCAN_SAZ_MAX_BASE64_CHARS);
  assert.deepEqual(parseFiddleText(tooBig), []);
});

// ---------------------------------------------------------------------------
// 3. 服务层：整体放行 / 整体拒绝 + 告警
// ---------------------------------------------------------------------------

test("scan_site：大 SAZ 归档照样产出命令（服务层不截断 base64）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "fiddler_saz", text: BIG_SAZ_BASE64 }],
    });
    assert.ok(report.commandCount > 0, "大归档必须照常产出命令");
    assert.ok(!report.warnings.includes(SITE_SCAN_SOURCE_FAILED_WARNING), "不应报数据源失败");
  });
});

test("scan_site：超配额的 SAZ 整体拒绝并给固定告警（0 命令）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "fiddler_saz", text: "UEsD" + "A".repeat(SITE_SCAN_SAZ_MAX_BASE64_CHARS) }],
    });
    assert.equal(report.commandCount, 0);
    assert.ok(
      report.warnings.includes(SITE_SCAN_SOURCE_FAILED_WARNING),
      `告警应包含数据源失败，实际 ${JSON.stringify(report.warnings)}`,
    );
  });
});

test("scan_site：非 SAZ 来源维持原有截断行为（本次改动不外溢到其它来源）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    // 端点字面量放在 2MB 之后：按原有上限截断后必然丢失。
    const late = `${"y".repeat(SITE_SCAN_MAX_TEXT_CHARS + 1024)}\nfetch('/api/v1/late-endpoint');`;
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "js", text: late }],
    });
    assert.equal(report.commandCount, 0, "普通文本仍按原上限截断（行为未变）");
  });
});

// ---------------------------------------------------------------------------
// 4. 召回归档护栏
// ---------------------------------------------------------------------------

test("召回归档护栏：四类来源的端点候选数固定不变", () => {
  assert.equal(scanJsText(JS_BUNDLE).length, 5);
  assert.equal(parseOpenApiText(OPENAPI).length, 3);
  assert.equal(parseHarText(HAR).length, 1);
  assert.equal(parseCommandSetText(COMMAND_SET).length, 1);
});

test("召回归档护栏：四源合并后的候选数与歧义数固定不变", () => {
  const scanned = scanSources(RECALL_FIXTURES, { domain: "example.com", maxEndpoints: 200 });
  assert.equal(scanned.candidates.length, 9);
  assert.equal((scanned.ambiguities ?? []).length, 0);
});

// ---------------------------------------------------------------------------
// 5. coverage 分子口径 = 端点维度 observed
// ---------------------------------------------------------------------------

test("coverageRate 的分子是端点维度 observed（总档位恒 unknown，不能当分子）", () => {
  const coverage = buildCoverage({
    scope: "domain",
    batchCommandCount: 1,
    endpointCount: 1,
    provenances: [{ tier: "unknown", endpoint: "observed", params: "observed", response: "unknown" }],
    verifiedCount: 0,
    ambiguities: [],
  });
  assert.equal(coverage.byTier.observed, 0, "总档位取三维最弱 → 不是 observed");
  assert.equal(coverage.coverageRate, 1, "端点维度是 observed → 真实覆盖率为 1");
  assert.equal(coverage.dimensionRates.endpoint, 1);
  assert.equal(coverage.dimensionRates.response, 0, "静态推导没有响应样本 → 响应维恒 0");
});

test("scan_site 只有 HAR 真实流量时，域名真实覆盖率为 1（不是 0）", async () => {
  await withCache(async (cache) => {
    const service = new ApiCommandService(cache, async () => { throw new Error("不应调用"); });
    const report = await service.analyze({
      action: "scan_site",
      domain: "example.com",
      sources: [{ kind: "har", text: HAR_ONE }],
    });
    assert.ok(report.coverage);
    assert.equal(report.coverage.scope, "domain");
    assert.equal(report.coverage.coverageRate, 1, "端点被真实流量观测到 → 覆盖率 1");
    assert.equal(report.coverage.byTier.observed, 0, "总档位因响应维 unknown 而非 observed");
    assert.equal(report.coverage.dimensionRates.response, 0);
  });
});
