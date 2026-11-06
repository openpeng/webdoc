// Fiddler SAZ 来源类型：真实流量归档（与 HAR 同一路）+ 纯函数层无 IO。
//
// 全部导入 ../dist/*.js 编译产物，可被 node --test 直测（无网络、无浏览器）。
// 覆盖：
//   1. 三种输入形态：SAZ 归档本体（base64）/ HTTP XML 会话 / raw HTTP 报文；
//   2. 证据档位：SAZ 属真实流量归档 → observed（与 HAR 同档）；
//   3. 端到端：scan_sources → 归一 → 生成，档位与 HAR 一致；
//   4. 歧义：同路径跨 origin → observedHosts + host 歧义（不猜）；
//   5. 纪律：只留字段名不留取值；解析层无 IO。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  parseFiddleText, scanSources, toScanRecords,
} from "../dist/api-command-site-scan.js";
import { decodeSazArchive, looksLikeSazArchive } from "../dist/api-command-saz.js";
import { tierForSourceKind, tierForSourceKinds } from "../dist/api-command-evidence.js";
import { groupEndpoints } from "../dist/api-command-normalize.js";
import { generateCommands } from "../dist/api-command-generator.js";
import { SITE_SCAN_KINDS } from "../dist/api-command-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** Fiddler SAZ 的 raw HTTP 报文（客户端文件内容形态）。 */
const RAW_HTTP = [
  "GET https://api.example.com/api/v1/courses?page=2&size=20 HTTP/1.1",
  "Host: api.example.com",
  "User-Agent: Fiddler",
  "",
  "",
  "POST https://api.example.com/api/v1/orders HTTP/1.1",
  "Host: api.example.com",
  "Content-Type: application/json",
  "",
  '{"keyword":"sample-secret","size":10}',
  "",
].join("\n");

/** Fiddler HTTP XML 会话形态。 */
const XML_SESSION = `<?xml version="1.0" encoding="utf-8"?>
<Session SID="1" BitFlags="81">
  <SessionFlags><SessionFlag N="x-requestid" V="{GUID}" /></SessionFlags>
  <Request>
    <Method>POST</Method>
    <FullUrl>https://api.example.com/api/v1/search?kw=books&amp;limit=5</FullUrl>
    <Headers>
      <Header Name="Content-Type">application/json</Header>
    </Headers>
    <Body>{"query":"sample-secret","filters":{"tag":"x"}}</Body>
  </Request>
  <Response>
    <StatusCode>200</StatusCode>
    <Headers><Header Name="Content-Type">application/json</Header></Headers>
  </Response>
</Session>`;

/** CRC32（造 ZIP 用；Node 21 的 zlib 还没有 crc32）。 */
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

/** 造一个最小 ZIP（store 或 deflate），用来模拟 Fiddler 导出的 .saz 归档。 */
function buildZip(files, { deflate = false } = {}) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centralChunks.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

/** 造一份 Fiddler SAZ：raw/N_c.txt + raw/N_s.txt + _index.htm。 */
function buildSazBase64({ deflate = false } = {}) {
  const zip = buildZip([
    ["_index.htm", "<html><body>sessions</body></html>"],
    ["raw/1_c.txt", RAW_HTTP],
    ["raw/1_s.txt", "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}"],
  ], { deflate });
  return zip.toString("base64");
}

// ---------------------------------------------------------------------------
// 1. 来源种类与证据档位
// ---------------------------------------------------------------------------

test("SAZ 是受支持的来源种类，且与 HAR 同为 observed 档", () => {
  assert.ok(SITE_SCAN_KINDS.includes("fiddler_saz"), "来源种类清单必须含 fiddler_saz");
  // 真实流量归档 → observed（与 HAR 同档，不因是「静态推导」而降级）。
  assert.equal(tierForSourceKind("fiddler_saz"), "observed");
  assert.equal(tierForSourceKind("har"), "observed");
  // 多来源合并取最强档：bundle 的弱证据不否定 SAZ 的观测。
  assert.equal(tierForSourceKinds(["js", "fiddler_saz"]), "observed");
  assert.equal(tierForSourceKinds(["js"]), "inferred");
});

// ---------------------------------------------------------------------------
// 2. raw HTTP 报文解析
// ---------------------------------------------------------------------------

test("parseFiddleText 解析 raw HTTP 报文：method / 路径 / 参数名", () => {
  const candidates = parseFiddleText(RAW_HTTP);
  assert.equal(candidates.length, 2);
  const get = candidates.find((c) => c.method === "GET");
  const post = candidates.find((c) => c.method === "POST");
  assert.ok(get && post);
  assert.equal(get.pathTemplate, "/api/v1/courses");
  assert.deepEqual(get.queryNames.sort(), ["page", "size"]);
  assert.equal(post.pathTemplate, "/api/v1/orders");
  assert.deepEqual(post.bodyNames.sort(), ["keyword", "size"]);
  assert.ok(candidates.every((c) => c.origin === "fiddler_saz"));
});

test("parseFiddleText 只保留字段名，绝不保留取值 / 凭据", () => {
  const candidates = parseFiddleText(RAW_HTTP);
  assert.ok(candidates.length > 0, "解析器必须真的解析出候选，否则下面的“无取值”断言是平凡通过");
  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes("sample-secret"), "请求体取值不得进入产物");
  assert.ok(!serialized.includes("page=2"), "query 取值不得进入产物");
  assert.ok(!serialized.includes("Fiddler"), "请求头取值不得进入产物");
});

test("parseFiddleText 对空输入 / 垃圾输入 fail-closed", () => {
  assert.deepEqual(parseFiddleText(""), []);
  assert.deepEqual(parseFiddleText("   "), []);
  assert.deepEqual(parseFiddleText("not a session at all"), []);
  assert.deepEqual(parseFiddleText("{"), []);
});

// ---------------------------------------------------------------------------
// 3. HTTP XML 会话解析
// ---------------------------------------------------------------------------

test("parseFiddleText 解析 Fiddler HTTP XML 会话", () => {
  const candidates = parseFiddleText(XML_SESSION);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.method, "POST");
  assert.equal(candidate.pathTemplate, "/api/v1/search");
  assert.ok(candidate.queryNames.includes("kw"), `实际 ${JSON.stringify(candidate.queryNames)}`);
  assert.deepEqual(candidate.bodyNames.sort(), ["filters", "query"]);
  assert.equal(candidate.origin, "fiddler_saz");
  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes("sample-secret"), "请求体取值不得进入产物");
  assert.ok(!serialized.includes("{GUID}"), "会话头取值不得进入产物");
});

// ---------------------------------------------------------------------------
// 4. SAZ 归档本体（base64）
// ---------------------------------------------------------------------------

test("looksLikeSazArchive 只认 ZIP 魔数（base64 或原始字节）", () => {
  assert.equal(looksLikeSazArchive(buildSazBase64()), true);
  assert.equal(looksLikeSazArchive("UEsDBAo="), true);
  assert.equal(looksLikeSazArchive("hello"), false);
  assert.equal(looksLikeSazArchive(""), false);
});

test("decodeSazArchive 解出 SAZ 条目（store 与 deflate 都支持）", () => {
  for (const deflate of [false, true]) {
    const result = decodeSazArchive(buildSazBase64({ deflate }));
    assert.equal(result.ok, true, `deflate=${deflate} 应能解包`);
    const names = result.entries.map((entry) => entry.name);
    assert.ok(names.includes("raw/1_c.txt"), `实际 ${JSON.stringify(names)}`);
    const client = result.entries.find((entry) => entry.name === "raw/1_c.txt");
    assert.ok(client.text.includes("/api/v1/courses"));
  }
});

test("parseFiddleText 直接吃 SAZ 归档本体（base64），端点召回不打折", () => {
  const candidates = parseFiddleText(buildSazBase64({ deflate: true }));
  assert.equal(candidates.length, 2, "归档里的两条会话都应被解析出来");
  const paths = candidates.map((c) => c.pathTemplate).sort();
  assert.deepEqual(paths, ["/api/v1/courses", "/api/v1/orders"]);
});

test("decodeSazArchive 对非归档输入 fail-closed（不抛异常）", () => {
  const result = decodeSazArchive("not a zip file at all");
  assert.equal(result.ok, false);
  assert.equal(result.entries.length, 0);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

// ---------------------------------------------------------------------------
// 5. 端到端：来源透传 + 档位
// ---------------------------------------------------------------------------

test("SAZ 候选经管线后端点档位为 observed、响应档位仍为 unknown", () => {
  const scanned = scanSources(
    [{ kind: "fiddler_saz", text: RAW_HTTP }],
    { domain: "example.com", maxEndpoints: 50 },
  );
  assert.equal(scanned.candidates.length, 2);
  assert.ok(scanned.candidates.every((c) => c.sourceKinds?.includes("fiddler_saz")));
  const records = toScanRecords(scanned.candidates, "example.com");
  const groups = groupEndpoints(records);
  const generated = generateCommands(groups, {
    domain: "example.com",
    analysisId: "an_test",
    generatedBy: "test",
    schema: new Map(),
    now: NOW,
    sourceOrigin: "scan",
    provenance: true,
  });
  assert.ok(generated.commands.length > 0);
  for (const command of generated.commands) {
    assert.equal(command.source.provenance.endpoint, "observed");
    // 静态推导没有真实响应样本 → 响应档位恒 unknown，总档位取最弱。
    assert.equal(command.source.provenance.response, "unknown");
    assert.equal(command.source.provenance.tier, "unknown");
  }
});

test("SAZ 与 HAR 同键候选合并，来源种类取并集", () => {
  const scanned = scanSources([
    { kind: "har", text: JSON.stringify({ log: { entries: [
      { request: { url: "https://example.com/api/v1/courses?page=2", method: "GET" } },
    ] } }) },
    { kind: "fiddler_saz", text: RAW_HTTP },
  ], { domain: "example.com", maxEndpoints: 50 });
  const courses = scanned.candidates.find((c) => c.pathTemplate === "/api/v1/courses");
  assert.ok(courses, "同键候选必须合并成一条");
  assert.deepEqual(courses.sourceKinds.sort(), ["fiddler_saz", "har"]);
});

// ---------------------------------------------------------------------------
// 6. 歧义：同路径跨 origin（不猜）
// ---------------------------------------------------------------------------

test("SAZ 里同一路径跨多个 origin 时记 observedHosts，不静默拍平", () => {
  const text = [
    "GET https://a.example.com/api/v1/courses HTTP/1.1",
    "Host: a.example.com",
    "",
    "",
    "GET https://b.example.com/api/v1/courses HTTP/1.1",
    "Host: b.example.com",
    "",
    "",
  ].join("\n");
  const candidates = parseFiddleText(text);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].observedHosts, ["a.example.com", "b.example.com"]);

  const scanned = scanSources([{ kind: "fiddler_saz", text }], {
    domain: "example.com", maxEndpoints: 50,
  });
  const hostAmbiguities = (scanned.ambiguities ?? []).filter((a) => a.kind === "host");
  assert.equal(hostAmbiguities.length, 1, "跨 origin 必须显式记为 host 歧义");
  assert.equal(hostAmbiguities[0].candidateCount, 2);
});

// ---------------------------------------------------------------------------
// 7. 纪律：解析层无 IO
// ---------------------------------------------------------------------------

test("解析层无 IO：无 node:fs / 无 fetch 调用 / 无 Date.now / 无环境变量", () => {
  const files = [
    join(here, "..", "dist", "api-command-site-scan.js"),
    join(here, "..", "dist", "api-command-saz.js"),
    join(here, "..", "dist", "api-command-evidence.js"),
  ];
  // 先剥掉注释：文件头里「本文件不 import node:fs」这类说明不能算命中。
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    assert.ok(!/from\s*["']node:fs/.test(source), `${file} 不得引入 node:fs`);
    assert.ok(!/require\(\s*["']node:fs/.test(source), `${file} 不得引入 node:fs`);
    assert.ok(!/await\s+fetch\(/.test(source), `${file} 不得发起 fetch`);
    assert.ok(!/Date\.now\(/.test(source), `${file} 不得读墙钟`);
    assert.ok(!/process\.env/.test(source), `${file} 不得读环境变量`);
  }
});
